//! Microphone capture for dictation. The input stream exists only while a
//! recording runs (the system's microphone indicator shows exactly then); the
//! samples are mixed to mono, resampled to 16 kHz and kept as 16-bit PCM.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const RATE: u32 = 16_000;

/// Box-filter resampler: each output sample is the mean of the input samples it covers.
/// Good enough for speech recognition, and cheap.
pub struct Resampler {
    step: f64,
    pos: f64,
    acc: f64,
    n: u32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Resampler {
        Resampler {
            step: f64::from(from) / f64::from(to),
            pos: 0.0,
            acc: 0.0,
            n: 0,
        }
    }

    pub fn push(&mut self, mono: &[f32], out: &mut Vec<i16>) {
        for &s in mono {
            self.acc += f64::from(s);
            self.n += 1;
            self.pos += 1.0;
            if self.pos >= self.step {
                self.pos -= self.step;
                let v = (self.acc / f64::from(self.n)).clamp(-1.0, 1.0);
                out.push((v * 32767.0) as i16);
                self.acc = 0.0;
                self.n = 0;
            }
        }
    }
}

/// A 16 kHz mono 16-bit WAV file.
pub fn wav(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Loudest sample, 0..1.
pub fn peak(samples: &[i16]) -> f32 {
    samples
        .iter()
        .map(|s| (i32::from(*s)).unsigned_abs())
        .max()
        .unwrap_or(0) as f32
        / 32768.0
}

#[derive(Default)]
struct Shared {
    samples: Mutex<Vec<i16>>,
    /// Recent level, f32 bits, 0..1 (for the HUD meter).
    level: AtomicU32,
    failed: AtomicBool,
}

/// A running recording. Dropping it stops the microphone.
pub struct Recording {
    shared: Arc<Shared>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub device: String,
}

impl Recording {
    pub fn level(&self) -> f32 {
        f32::from_bits(self.shared.level.load(Ordering::Relaxed))
    }

    pub fn failed(&self) -> bool {
        self.shared.failed.load(Ordering::Relaxed)
    }

    /// Current number of captured 16 kHz mono samples.
    #[allow(dead_code)]
    pub fn sample_len(&self) -> usize {
        self.shared.samples.lock().map(|s| s.len()).unwrap_or(0)
    }

    /// Copies samples starting at `offset` without interrupting the active recording stream.
    #[allow(dead_code)]
    pub fn snapshot_from(&self, offset: usize) -> Vec<i16> {
        self.shared
            .samples
            .lock()
            .map(|s| {
                if offset >= s.len() {
                    Vec::new()
                } else {
                    s[offset..].to_vec()
                }
            })
            .unwrap_or_default()
    }

    /// Stops the microphone and returns the 16 kHz samples.
    pub fn finish(mut self) -> Vec<i16> {
        self.close();
        self.shared
            .samples
            .lock()
            .map(|mut s| std::mem::take(&mut *s))
            .unwrap_or_default()
    }

    fn close(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.close();
    }
}

fn mono_from<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32, out: &mut Vec<f32>) {
    out.clear();
    if channels <= 1 {
        out.extend(data.iter().map(|s| to_f32(*s)));
        return;
    }
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().map(|s| to_f32(*s)).sum();
        out.push(sum / frame.len() as f32);
    }
}

/// Opens the default input device and starts recording. Blocks until the stream runs (or fails).
pub fn start(max_seconds: u32) -> Result<Recording, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let shared = Arc::new(Shared::default());
    let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let sh = shared.clone();
    let max_samples = (RATE * max_seconds.max(1)) as usize;
    let thread = std::thread::Builder::new()
        .name("pocket-mic".into())
        .spawn(move || {
            let host = cpal::default_host();
            let Some(device) = host.default_input_device() else {
                let _ = ready_tx.send(Err("没有找到麦克风".into()));
                return;
            };
            let name = device
                .description()
                .map(|d| d.to_string())
                .unwrap_or_else(|_| "default".into());
            let supported = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("麦克风无法使用：{e}")));
                    return;
                }
            };
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.config();
            let channels = usize::from(config.channels.max(1));
            let rate = config.sample_rate;
            let err_sh = sh.clone();
            let on_err = move |_e: cpal::Error| {
                err_sh.failed.store(true, Ordering::Relaxed);
            };
            macro_rules! stream_of {
                ($t:ty, $conv:expr) => {{
                    let sh = sh.clone();
                    let mut rs = Resampler::new(rate, RATE);
                    let mut mono = Vec::new();
                    let mut out = Vec::new();
                    device.build_input_stream::<$t, _, _>(
                        config.clone(),
                        move |data: &[$t], _: &cpal::InputCallbackInfo| {
                            mono_from(data, channels, $conv, &mut mono);
                            let lvl = mono.iter().fold(0f32, |m, s| m.max(s.abs()));
                            sh.level.store(lvl.min(1.0).to_bits(), Ordering::Relaxed);
                            out.clear();
                            rs.push(&mono, &mut out);
                            if let Ok(mut buf) = sh.samples.lock() {
                                if buf.len() < max_samples {
                                    let room = max_samples - buf.len();
                                    buf.extend_from_slice(&out[..out.len().min(room)]);
                                }
                            }
                        },
                        on_err,
                        Some(Duration::from_secs(2)),
                    )
                }};
            }
            let stream = match format {
                cpal::SampleFormat::F32 => stream_of!(f32, |s: f32| s),
                cpal::SampleFormat::I16 => stream_of!(i16, |s: i16| f32::from(s) / 32768.0),
                cpal::SampleFormat::I32 => stream_of!(i32, |s: i32| s as f32 / 2_147_483_648.0),
                cpal::SampleFormat::U16 => {
                    stream_of!(u16, |s: u16| (f32::from(s) - 32768.0) / 32768.0)
                }
                other => {
                    let _ = ready_tx.send(Err(format!("不支持的麦克风格式：{other:?}")));
                    return;
                }
            };
            let stream = match stream {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("无法打开麦克风：{e}")));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(format!("无法开始录音：{e}")));
                return;
            }
            let _ = ready_tx.send(Ok(name));
            // Wait for stop (or for the owner to go away), then drop the stream: the microphone closes.
            let _ = stop_rx.recv();
            drop(stream);
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(device)) => Ok(Recording {
            shared,
            stop: Some(stop_tx),
            thread: Some(thread),
            device,
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = stop_tx.send(());
            Err("麦克风没有响应".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_16k() {
        let mut rs = Resampler::new(48_000, 16_000);
        let input = vec![0.5f32; 48_000];
        let mut out = Vec::new();
        rs.push(&input, &mut out);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|s| (*s - 16383).abs() <= 1));
    }

    #[test]
    fn resamples_44k1_in_chunks() {
        let mut rs = Resampler::new(44_100, 16_000);
        let mut out = Vec::new();
        for _ in 0..10 {
            rs.push(&vec![0.0f32; 4410], &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
    }

    #[test]
    fn wav_header() {
        let w = wav(&[0, 1, -1]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), RATE);
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 6);
        assert_eq!(w.len(), 44 + 6);
    }

    #[test]
    fn mixes_to_mono() {
        let mut out = Vec::new();
        mono_from(&[1.0f32, 0.0, 0.5, 0.5], 2, |s| s, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
    }
}
