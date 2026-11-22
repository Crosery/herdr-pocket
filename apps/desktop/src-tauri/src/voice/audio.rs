//! Microphone capture for dictation. The input stream exists only while a
//! recording runs (the system's microphone indicator shows exactly then); the
//! samples are mixed to mono, resampled to 16 kHz and kept as 16-bit PCM.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const RATE: u32 = 16_000;
#[allow(dead_code)]
pub const LIVE_FRAME_SAMPLES: usize = 320;

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
#[cfg_attr(not(test), allow(dead_code))]
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
#[allow(dead_code)]
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
    #[allow(dead_code)]
    pub device: String,
}

impl Recording {
    #[allow(dead_code)]
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

fn spawn_cpal_capture<S>(
    thread_name: &str,
    failed: Arc<AtomicBool>,
    on_chunk: S,
) -> Result<(String, mpsc::Sender<()>, std::thread::JoinHandle<()>), String>
where
    S: FnMut(&[f32], &[i16]) + Send + 'static,
{
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name(thread_name.into())
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
            let err_flag = failed.clone();
            let on_err = move |_e: cpal::Error| {
                err_flag.store(true, Ordering::Relaxed);
            };
            macro_rules! stream_of {
                ($t:ty, $conv:expr, $cb:expr) => {{
                    let mut cb = $cb;
                    let mut rs = Resampler::new(rate, RATE);
                    let mut mono = Vec::new();
                    let mut out = Vec::new();
                    device.build_input_stream::<$t, _, _>(
                        config.clone(),
                        move |data: &[$t], _: &cpal::InputCallbackInfo| {
                            mono_from(data, channels, $conv, &mut mono);
                            out.clear();
                            rs.push(&mono, &mut out);
                            cb(&mono, &out);
                        },
                        on_err,
                        Some(Duration::from_secs(2)),
                    )
                }};
            }
            let stream = match format {
                cpal::SampleFormat::F32 => stream_of!(f32, |s: f32| s, on_chunk),
                cpal::SampleFormat::I16 => {
                    stream_of!(i16, |s: i16| f32::from(s) / 32768.0, on_chunk)
                }
                cpal::SampleFormat::I32 => {
                    stream_of!(i32, |s: i32| s as f32 / 2_147_483_648.0, on_chunk)
                }
                cpal::SampleFormat::U16 => {
                    stream_of!(u16, |s: u16| (f32::from(s) - 32768.0) / 32768.0, on_chunk)
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
        Ok(Ok(device)) => Ok((device, stop_tx, thread)),
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

/// Opens the default input device and starts recording. Blocks until the stream runs (or fails).
pub fn start(max_seconds: u32) -> Result<Recording, String> {
    let shared = Arc::new(Shared::default());
    let failed = Arc::new(AtomicBool::new(false));
    let max_samples = (RATE * max_seconds.max(1)) as usize;
    let sh = shared.clone();
    let fl = failed.clone();
    let res = spawn_cpal_capture("pocket-mic", failed, move |mono, out| {
        let lvl = mono.iter().fold(0f32, |m, s| m.max(s.abs()));
        sh.level.store(lvl.min(1.0).to_bits(), Ordering::Relaxed);
        if let Ok(mut buf) = sh.samples.lock() {
            if buf.len() < max_samples {
                let room = max_samples - buf.len();
                buf.extend_from_slice(&out[..out.len().min(room)]);
            }
        }
        if fl.load(Ordering::Relaxed) {
            sh.failed.store(true, Ordering::Relaxed);
        }
    });
    match res {
        Ok((device, stop_tx, thread)) => Ok(Recording {
            shared,
            stop: Some(stop_tx),
            thread: Some(thread),
            device,
        }),
        Err(e) => Err(e),
    }
}

#[allow(dead_code)]
pub(crate) struct FrameBatcher320 {
    buf: Vec<i16>,
}

#[allow(dead_code)]
impl FrameBatcher320 {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(LIVE_FRAME_SAMPLES * 2),
        }
    }

    pub fn push_with<P, F>(
        &mut self,
        samples: &[i16],
        muted: bool,
        mut process: P,
        mut on_frame: F,
    ) where
        P: FnMut(&[i16]) -> ([i16; LIVE_FRAME_SAMPLES], f32),
        F: FnMut(&[i16; LIVE_FRAME_SAMPLES], f32),
    {
        if muted {
            self.buf.resize(self.buf.len() + samples.len(), 0);
        } else {
            self.buf.extend_from_slice(samples);
        }
        let mut offset = 0usize;
        while self.buf.len().saturating_sub(offset) >= LIVE_FRAME_SAMPLES {
            let frame = &self.buf[offset..offset + LIVE_FRAME_SAMPLES];
            offset += LIVE_FRAME_SAMPLES;
            if muted {
                let silence = [0i16; LIVE_FRAME_SAMPLES];
                on_frame(&silence, 0.0);
            } else {
                let (processed, level) = process(frame);
                on_frame(&processed, level);
            }
        }
        if offset > 0 {
            self.buf.drain(..offset);
        }
    }

    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.buf.len()
    }
}

/// Active 16 kHz mono call microphone stream. Dropping stops the `cpal` stream
/// cleanly, shutting off the OS microphone indicator.
#[allow(dead_code)]
pub struct LiveMicStream {
    failed: Arc<AtomicBool>,
    stop: Option<mpsc::Sender<()>>,
    capture_thread: Option<std::thread::JoinHandle<()>>,
    dsp_thread: Option<std::thread::JoinHandle<()>>,
    pub device: String,
}

#[allow(dead_code)]
impl LiveMicStream {
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }

    pub fn stop(mut self) {
        self.close();
    }

    fn close(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.capture_thread.take() {
            let _ = t.join();
        }
        if let Some(t) = self.dsp_thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for LiveMicStream {
    fn drop(&mut self) {
        self.close();
    }
}

/// Opens the default microphone, resamples to 16 kHz mono, batches 320-sample
/// (20 ms) frames through `LiveCallProcessor`, and delivers enhanced PCM16 + RMS level.
#[allow(dead_code)]
pub fn start_live_call_mic<F>(
    muted: Arc<AtomicBool>,
    mut on_frame: F,
) -> Result<LiveMicStream, String>
where
    F: FnMut(&[i16; 320], f32) + Send + 'static,
{
    let failed = Arc::new(AtomicBool::new(false));
    let (pcm_tx, pcm_rx) = mpsc::sync_channel::<Vec<i16>>(256);
    let dsp_muted = muted.clone();
    let dsp_thread = std::thread::Builder::new()
        .name("pocket-call-dsp".into())
        .spawn(move || {
            let mut processor = crate::voice_ai::LiveCallProcessor::new();
            let mut batcher = FrameBatcher320::new();
            while let Ok(chunk) = pcm_rx.recv() {
                let is_muted = dsp_muted.load(Ordering::Relaxed);
                batcher.push_with(
                    &chunk,
                    is_muted,
                    |frame| processor.process_frame_320(frame),
                    &mut on_frame,
                );
            }
        })
        .map_err(|e| e.to_string())?;

    let cap = spawn_cpal_capture("pocket-call-mic", failed.clone(), move |_mono, out| {
        if !out.is_empty() {
            let _ = pcm_tx.try_send(out.to_vec());
        }
    });
    match cap {
        Ok((device, stop_tx, capture_thread)) => Ok(LiveMicStream {
            failed,
            stop: Some(stop_tx),
            capture_thread: Some(capture_thread),
            dsp_thread: Some(dsp_thread),
            device,
        }),
        Err(e) => {
            if e != "麦克风没有响应" {
                let _ = dsp_thread.join();
            }
            Err(e)
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

    #[test]
    fn batches_arbitrary_chunks_into_exact_320_sample_frames() {
        let mut batcher = FrameBatcher320::new();
        let mut emitted = Vec::<([i16; 320], f32)>::new();

        let chunk1: Vec<i16> = (0..100).collect();
        batcher.push_with(
            &chunk1,
            false,
            |f| (f.try_into().unwrap(), 0.25),
            |f, lvl| emitted.push((*f, lvl)),
        );
        assert_eq!(emitted.len(), 0);
        assert_eq!(batcher.pending_len(), 100);

        let chunk2: Vec<i16> = (100..650).collect();
        batcher.push_with(
            &chunk2,
            false,
            |f| (f.try_into().unwrap(), 0.5),
            |f, lvl| emitted.push((*f, lvl)),
        );
        assert_eq!(emitted.len(), 2);
        assert_eq!(batcher.pending_len(), 10);
        assert_eq!(emitted[0].0[0], 0);
        assert_eq!(emitted[0].0[319], 319);
        assert_eq!(emitted[1].0[0], 320);
        assert_eq!(emitted[1].0[319], 639);
        assert_eq!(emitted[0].1, 0.5);

        let chunk3: Vec<i16> = (650..960).collect();
        batcher.push_with(
            &chunk3,
            false,
            |f| (f.try_into().unwrap(), 0.75),
            |f, lvl| emitted.push((*f, lvl)),
        );
        assert_eq!(emitted.len(), 3);
        assert_eq!(batcher.pending_len(), 0);
        assert_eq!(emitted[2].0[0], 640);
        assert_eq!(emitted[2].0[319], 959);
    }

    #[test]
    fn muted_frame_batcher_emits_silence_and_zero_level_and_recovers() {
        let mut batcher = FrameBatcher320::new();
        let mut emitted = Vec::<([i16; 320], f32)>::new();
        let mut processor_calls = 0usize;

        // Pre-fill 100 unmuted samples before muting.
        let pre = vec![1234i16; 100];
        batcher.push_with(
            &pre,
            false,
            |_| {
                processor_calls += 1;
                ([1; 320], 0.9)
            },
            |f, lvl| emitted.push((*f, lvl)),
        );
        assert_eq!(emitted.len(), 0);

        // Mute with 540 incoming samples -> emits 2 silent frames with level 0.0 without calling processor.
        let loud = vec![9999i16; 540];
        batcher.push_with(
            &loud,
            true,
            |_| {
                processor_calls += 1;
                ([2; 320], 0.9)
            },
            |f, lvl| emitted.push((*f, lvl)),
        );
        assert_eq!(processor_calls, 0);
        assert_eq!(emitted.len(), 2);
        assert!(emitted.iter().all(|(f, lvl)| f.iter().all(|&s| s == 0) && *lvl == 0.0));

        // Unmute with 320 samples -> processor resumes normally.
        let resumed = vec![500i16; 320];
        batcher.push_with(
            &resumed,
            false,
            |f| {
                processor_calls += 1;
                (f.try_into().unwrap(), 0.42)
            },
            |f, lvl| emitted.push((*f, lvl)),
        );
        assert_eq!(processor_calls, 1);
        assert_eq!(emitted.len(), 3);
        assert_eq!(emitted[2].1, 0.42);
    }

    #[test]
    fn resampler_and_batcher_emit_320_sample_frames_through_live_call_processor() {
        let mut rs = Resampler::new(48_000, RATE);
        let mut batcher = FrameBatcher320::new();
        let mut proc = crate::voice_ai::LiveCallProcessor::with_config(
            crate::voice_ai::VoiceAiConfig {
                denoise: true,
                enhance_vocal: true,
                filter: false,
                first_speaker: false,
                ..Default::default()
            },
        );

        let mut mono_48k = Vec::with_capacity(4_800);
        for i in 0..4_800 {
            mono_48k.push(
                0.25 * (2.0 * std::f64::consts::PI * 600.0 * (i as f64) / 48_000.0).sin() as f32,
            );
        }
        let mut pcm_16k = Vec::new();
        rs.push(&mono_48k, &mut pcm_16k);
        assert_eq!(pcm_16k.len(), 1_600);

        let mut frames = 0usize;
        let mut last_lvl = 0.0f32;
        batcher.push_with(
            &pcm_16k,
            false,
            |f| proc.process_frame_320(f),
            |out, lvl| {
                assert_eq!(out.len(), 320);
                frames += 1;
                last_lvl = lvl;
            },
        );
        assert_eq!(frames, 5);
        assert!(last_lvl > 0.0 && last_lvl <= 1.0, "unexpected level {last_lvl}");
    }
}
