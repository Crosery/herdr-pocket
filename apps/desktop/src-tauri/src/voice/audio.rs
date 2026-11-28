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

#[cfg(target_os = "macos")]
mod macos_vpio {
    use super::RATE;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    pub(super) const NO_ERR: i32 = 0;

    // Apple AudioToolbox / CoreAudioTypes constants (verified against macOS SDK headers).
    pub(super) const K_AUDIO_UNIT_TYPE_OUTPUT: u32 = 0x6175_6f75; // 'auou'
    pub(super) const K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO: u32 = 0x7670_696f; // 'vpio'
    pub(super) const K_AUDIO_UNIT_MANUFACTURER_APPLE: u32 = 0x6170_706c; // 'appl'

    pub(super) const K_AUDIO_FORMAT_LINEAR_PCM: u32 = 0x6c70_636d; // 'lpcm'
    pub(super) const K_AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 0x0000_0001;
    pub(super) const K_AUDIO_FORMAT_FLAG_IS_PACKED: u32 = 0x0000_0008;

    pub(super) const K_AUDIO_UNIT_SCOPE_GLOBAL: u32 = 0;
    pub(super) const K_AUDIO_UNIT_SCOPE_INPUT: u32 = 1;
    pub(super) const K_AUDIO_UNIT_SCOPE_OUTPUT: u32 = 2;

    pub(super) const OUTPUT_BUS: u32 = 0;
    pub(super) const INPUT_BUS: u32 = 1;

    pub(super) const K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT: u32 = 8;
    pub(super) const K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK: u32 = 23;
    pub(super) const K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO: u32 = 2003;
    pub(super) const K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK: u32 = 2005;
    pub(super) const K_AU_VOICE_IO_PROPERTY_BYPASS_VOICE_PROCESSING: u32 = 2100;
    pub(super) const K_AU_VOICE_IO_PROPERTY_VOICE_PROCESSING_ENABLE_AGC: u32 = 2101;

    pub(super) const K_AUDIO_UNIT_RENDER_ACTION_OUTPUT_IS_SILENCE: u32 = 0x0000_0010;

    const INITIAL_SCRATCH_FRAMES: usize = 4096;
    const MAX_CALLBACK_FRAMES: usize = 65_536;
    const CONSECUTIVE_RENDER_ERROR_LIMIT: u32 = 50;

    pub(super) type AudioComponent = *mut c_void;
    pub(super) type AudioComponentInstance = *mut c_void;

    #[repr(C)]
    pub(super) struct AudioTimeStamp {
        _private: [u8; 0],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct AudioComponentDescription {
        pub component_type: u32,
        pub component_sub_type: u32,
        pub component_manufacturer: u32,
        pub component_flags: u32,
        pub component_flags_mask: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct AudioStreamBasicDescription {
        pub m_sample_rate: f64,
        pub m_format_id: u32,
        pub m_format_flags: u32,
        pub m_bytes_per_packet: u32,
        pub m_frames_per_packet: u32,
        pub m_bytes_per_frame: u32,
        pub m_channels_per_frame: u32,
        pub m_bits_per_channel: u32,
        pub m_reserved: u32,
    }

    #[repr(C)]
    pub(super) struct AudioBuffer {
        pub m_number_channels: u32,
        pub m_data_byte_size: u32,
        pub m_data: *mut c_void,
    }

    #[repr(C)]
    pub(super) struct AudioBufferList {
        pub m_number_buffers: u32,
        pub m_buffers: [AudioBuffer; 1],
    }

    pub(super) type AURenderCallback = unsafe extern "C" fn(
        in_ref_con: *mut c_void,
        io_action_flags: *mut u32,
        in_time_stamp: *const AudioTimeStamp,
        in_bus_number: u32,
        in_number_frames: u32,
        io_data: *mut AudioBufferList,
    ) -> i32;

    #[repr(C)]
    pub(super) struct AURenderCallbackStruct {
        pub input_proc: Option<AURenderCallback>,
        pub input_proc_ref_con: *mut c_void,
    }

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        pub(super) fn AudioComponentFindNext(
            in_component: AudioComponent,
            in_desc: *const AudioComponentDescription,
        ) -> AudioComponent;
        fn AudioComponentInstanceNew(
            in_component: AudioComponent,
            out_instance: *mut AudioComponentInstance,
        ) -> i32;
        fn AudioComponentInstanceDispose(in_instance: AudioComponentInstance) -> i32;
        fn AudioUnitSetProperty(
            in_unit: AudioComponentInstance,
            in_id: u32,
            in_scope: u32,
            in_element: u32,
            in_data: *const c_void,
            in_data_size: u32,
        ) -> i32;
        fn AudioUnitInitialize(in_unit: AudioComponentInstance) -> i32;
        fn AudioUnitUninitialize(in_unit: AudioComponentInstance) -> i32;
        fn AudioOutputUnitStart(in_unit: AudioComponentInstance) -> i32;
        fn AudioOutputUnitStop(in_unit: AudioComponentInstance) -> i32;
        fn AudioUnitRender(
            in_unit: AudioComponentInstance,
            io_action_flags: *mut u32,
            in_time_stamp: *const AudioTimeStamp,
            in_output_bus_number: u32,
            in_number_frames: u32,
            io_data: *mut AudioBufferList,
        ) -> i32;
    }

    pub(super) fn make_vpio_component_desc() -> AudioComponentDescription {
        AudioComponentDescription {
            component_type: K_AUDIO_UNIT_TYPE_OUTPUT,
            component_sub_type: K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO,
            component_manufacturer: K_AUDIO_UNIT_MANUFACTURER_APPLE,
            component_flags: 0,
            component_flags_mask: 0,
        }
    }

    pub(super) fn make_16k_mono_f32_asbd() -> AudioStreamBasicDescription {
        AudioStreamBasicDescription {
            m_sample_rate: f64::from(RATE),
            m_format_id: K_AUDIO_FORMAT_LINEAR_PCM,
            m_format_flags: K_AUDIO_FORMAT_FLAG_IS_FLOAT | K_AUDIO_FORMAT_FLAG_IS_PACKED,
            m_bytes_per_packet: 4,
            m_frames_per_packet: 1,
            m_bytes_per_frame: 4,
            m_channels_per_frame: 1,
            m_bits_per_channel: 32,
            m_reserved: 0,
        }
    }

    pub(super) fn f32_to_pcm16_into(mono: &[f32], out: &mut Vec<i16>) {
        out.clear();
        out.reserve(mono.len());
        for &s in mono {
            let v = if s.is_finite() {
                s.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            out.push((v * 32767.0) as i16);
        }
    }

    pub(super) struct VpioCallbackState<S> {
        unit: AudioComponentInstance,
        scratch: Vec<f32>,
        pcm_out: Vec<i16>,
        failed: Arc<AtomicBool>,
        consecutive_errors: u32,
        on_chunk: S,
    }

    impl<S> VpioCallbackState<S> {
        pub(super) fn new(failed: Arc<AtomicBool>, on_chunk: S) -> Self {
            Self {
                unit: std::ptr::null_mut(),
                scratch: vec![0.0f32; INITIAL_SCRATCH_FRAMES],
                pcm_out: Vec::with_capacity(INITIAL_SCRATCH_FRAMES),
                failed,
                consecutive_errors: 0,
                on_chunk,
            }
        }
    }

    /// Owns the heap-allocated callback state passed to CoreAudio.
    /// Must always be dropped strictly AFTER the owning `VpioUnit` has been stopped,
    /// uninitialized, and disposed so no RT callback can dereference freed memory.
    pub(super) struct CallbackStateGuard<S> {
        ptr: *mut VpioCallbackState<S>,
    }

    impl<S> CallbackStateGuard<S> {
        pub(super) fn new(state: VpioCallbackState<S>) -> Self {
            Self {
                ptr: Box::into_raw(Box::new(state)),
            }
        }

        pub(super) fn as_ptr(&self) -> *mut VpioCallbackState<S> {
            self.ptr
        }
    }

    impl<S> Drop for CallbackStateGuard<S> {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                unsafe {
                    drop(Box::from_raw(self.ptr));
                }
                self.ptr = std::ptr::null_mut();
            }
        }
    }

    /// RAII handle for an instantiated Apple `VoiceProcessingIO` AudioUnit.
    /// Guarantees Stop -> Uninitialize -> Dispose in strict reverse lifecycle order.
    pub(super) struct VpioUnit {
        unit: AudioComponentInstance,
        initialized: bool,
        started: bool,
    }

    impl VpioUnit {
        pub(super) fn new() -> Result<Self, String> {
            let desc = make_vpio_component_desc();
            let comp = unsafe { AudioComponentFindNext(std::ptr::null_mut(), &desc) };
            if comp.is_null() {
                return Err("AudioComponentFindNext did not find VoiceProcessingIO".into());
            }
            let mut unit: AudioComponentInstance = std::ptr::null_mut();
            let st = unsafe { AudioComponentInstanceNew(comp, &mut unit) };
            if st != NO_ERR || unit.is_null() {
                return Err(format!("AudioComponentInstanceNew failed (status={st})"));
            }
            Ok(Self {
                unit,
                initialized: false,
                started: false,
            })
        }

        pub(super) fn raw(&self) -> AudioComponentInstance {
            self.unit
        }

        fn set_property<T>(
            &self,
            prop: u32,
            scope: u32,
            element: u32,
            value: &T,
        ) -> Result<(), i32> {
            let st = unsafe {
                AudioUnitSetProperty(
                    self.unit,
                    prop,
                    scope,
                    element,
                    (value as *const T).cast::<c_void>(),
                    std::mem::size_of::<T>() as u32,
                )
            };
            if st == NO_ERR {
                Ok(())
            } else {
                Err(st)
            }
        }

        fn initialize(&mut self) -> Result<(), i32> {
            let st = unsafe { AudioUnitInitialize(self.unit) };
            if st == NO_ERR {
                self.initialized = true;
                Ok(())
            } else {
                Err(st)
            }
        }

        fn start(&mut self) -> Result<(), i32> {
            let st = unsafe { AudioOutputUnitStart(self.unit) };
            if st == NO_ERR {
                self.started = true;
                Ok(())
            } else {
                Err(st)
            }
        }
    }

    impl Drop for VpioUnit {
        fn drop(&mut self) {
            if !self.unit.is_null() {
                unsafe {
                    if self.started {
                        let _ = AudioOutputUnitStop(self.unit);
                        self.started = false;
                    }
                    if self.initialized {
                        let _ = AudioUnitUninitialize(self.unit);
                        self.initialized = false;
                    }
                    let _ = AudioComponentInstanceDispose(self.unit);
                }
                self.unit = std::ptr::null_mut();
            }
        }
    }

    pub(super) unsafe extern "C" fn silent_render_cb(
        _in_ref_con: *mut c_void,
        io_action_flags: *mut u32,
        _in_time_stamp: *const AudioTimeStamp,
        _in_bus_number: u32,
        _in_number_frames: u32,
        io_data: *mut AudioBufferList,
    ) -> i32 {
        if !io_action_flags.is_null() {
            *io_action_flags |= K_AUDIO_UNIT_RENDER_ACTION_OUTPUT_IS_SILENCE;
        }
        if !io_data.is_null() {
            let num_buffers = (*io_data).m_number_buffers as usize;
            let first_buf = std::ptr::addr_of_mut!((*io_data).m_buffers).cast::<AudioBuffer>();
            for i in 0..num_buffers {
                let buf = &mut *first_buf.add(i);
                if !buf.m_data.is_null() && buf.m_data_byte_size > 0 {
                    std::ptr::write_bytes(
                        buf.m_data.cast::<u8>(),
                        0,
                        buf.m_data_byte_size as usize,
                    );
                }
            }
        }
        NO_ERR
    }

    unsafe extern "C" fn input_cb<S>(
        in_ref_con: *mut c_void,
        io_action_flags: *mut u32,
        in_time_stamp: *const AudioTimeStamp,
        _in_bus_number: u32,
        in_number_frames: u32,
        _io_data: *mut AudioBufferList,
    ) -> i32
    where
        S: FnMut(&[f32], &[i16]) + Send + 'static,
    {
        if in_ref_con.is_null() || in_number_frames == 0 {
            return NO_ERR;
        }
        let n_frames = in_number_frames as usize;
        if n_frames > MAX_CALLBACK_FRAMES {
            return NO_ERR;
        }
        let state = &mut *in_ref_con.cast::<VpioCallbackState<S>>();
        if state.unit.is_null() {
            return NO_ERR;
        }
        if state.scratch.len() < n_frames {
            state.scratch.resize(n_frames, 0.0);
        }
        let byte_size = (n_frames * std::mem::size_of::<f32>()) as u32;
        let mut abl = AudioBufferList {
            m_number_buffers: 1,
            m_buffers: [AudioBuffer {
                m_number_channels: 1,
                m_data_byte_size: byte_size,
                m_data: state.scratch.as_mut_ptr().cast::<c_void>(),
            }],
        };

        let status = AudioUnitRender(
            state.unit,
            io_action_flags,
            in_time_stamp,
            INPUT_BUS,
            in_number_frames,
            &mut abl,
        );
        if status != NO_ERR {
            state.consecutive_errors = state.consecutive_errors.saturating_add(1);
            if state.consecutive_errors >= CONSECUTIVE_RENDER_ERROR_LIMIT {
                state.failed.store(true, Ordering::Relaxed);
            }
            return NO_ERR;
        }
        state.consecutive_errors = 0;

        let out_ptr = abl.m_buffers[0].m_data.cast::<f32>();
        let out_bytes = abl.m_buffers[0].m_data_byte_size as usize;
        let sample_count = (out_bytes / std::mem::size_of::<f32>()).min(n_frames);
        if out_ptr.is_null() || sample_count == 0 {
            return NO_ERR;
        }
        let mono = if std::ptr::eq(out_ptr, state.scratch.as_ptr()) {
            &state.scratch[..sample_count]
        } else {
            std::slice::from_raw_parts(out_ptr, sample_count)
        };
        f32_to_pcm16_into(mono, &mut state.pcm_out);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (state.on_chunk)(mono, &state.pcm_out);
        }));
        NO_ERR
    }

    pub(super) fn configure_and_init_vpio<S>(
        enable_output: bool,
        state_ptr: *mut VpioCallbackState<S>,
    ) -> Result<VpioUnit, String>
    where
        S: FnMut(&[f32], &[i16]) + Send + 'static,
    {
        let mut unit = VpioUnit::new()?;
        // Safe: unit has not been initialized or started yet; no RT audio thread reads state_ptr.
        unsafe {
            (*state_ptr).unit = unit.raw();
        }

        let enable_in: u32 = 1;
        unit.set_property(
            K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO,
            K_AUDIO_UNIT_SCOPE_INPUT,
            INPUT_BUS,
            &enable_in,
        )
        .map_err(|st| format!("EnableIO(input=1) failed (status={st})"))?;

        let enable_out: u32 = if enable_output { 1 } else { 0 };
        unit.set_property(
            K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO,
            K_AUDIO_UNIT_SCOPE_OUTPUT,
            OUTPUT_BUS,
            &enable_out,
        )
        .map_err(|st| format!("EnableIO(output={enable_out}) failed (status={st})"))?;

        let bypass_vp: u32 = 0;
        unit.set_property(
            K_AU_VOICE_IO_PROPERTY_BYPASS_VOICE_PROCESSING,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &bypass_vp,
        )
        .map_err(|st| format!("BypassVoiceProcessing(0) failed (status={st})"))?;

        let enable_agc: u32 = 0;
        if let Err(st) = unit.set_property(
            K_AU_VOICE_IO_PROPERTY_VOICE_PROCESSING_ENABLE_AGC,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &enable_agc,
        ) {
            crate::logging::warn(
                "voice.audio",
                "VoiceProcessingIO EnableAGC(0) unsupported; continuing with default AGC",
                serde_json::json!({ "status": st }),
            );
        }

        let asbd = make_16k_mono_f32_asbd();
        unit.set_property(
            K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
            K_AUDIO_UNIT_SCOPE_OUTPUT,
            INPUT_BUS,
            &asbd,
        )
        .map_err(|st| format!("StreamFormat(output, bus 1) failed (status={st})"))?;

        if enable_output {
            unit.set_property(
                K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
                K_AUDIO_UNIT_SCOPE_INPUT,
                OUTPUT_BUS,
                &asbd,
            )
            .map_err(|st| format!("StreamFormat(input, bus 0) failed (status={st})"))?;

            let render_cb = AURenderCallbackStruct {
                input_proc: Some(silent_render_cb),
                input_proc_ref_con: std::ptr::null_mut(),
            };
            unit.set_property(
                K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK,
                K_AUDIO_UNIT_SCOPE_INPUT,
                OUTPUT_BUS,
                &render_cb,
            )
            .map_err(|st| format!("SetRenderCallback(bus 0) failed (status={st})"))?;
        }

        let icb = AURenderCallbackStruct {
            input_proc: Some(input_cb::<S>),
            input_proc_ref_con: state_ptr.cast::<c_void>(),
        };
        unit.set_property(
            K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &icb,
        )
        .map_err(|st| format!("SetInputCallback failed (status={st})"))?;

        unit.initialize().map_err(|st| {
            format!("AudioUnitInitialize failed (enable_output={enable_output}, status={st})")
        })?;
        Ok(unit)
    }

    pub(super) fn spawn_vpio_capture<S>(
        thread_name: &str,
        failed: Arc<AtomicBool>,
        on_chunk: S,
    ) -> Result<(String, mpsc::Sender<()>, std::thread::JoinHandle<()>), String>
    where
        S: FnMut(&[f32], &[i16]) + Send + 'static,
    {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name(thread_name.into())
            .spawn(move || {
                // Declared FIRST so it is guaranteed to drop strictly AFTER `unit` stops & disposes.
                let state_guard = CallbackStateGuard::new(VpioCallbackState::new(failed, on_chunk));

                let (mut unit, device_label) =
                    match configure_and_init_vpio(false, state_guard.as_ptr()) {
                        Ok(u) => (u, "macOS VoiceProcessingIO (AEC+BF, input-only)".to_string()),
                        Err(first_err) => {
                            crate::logging::info(
                                "voice.audio",
                                "VoiceProcessingIO input-only init rejected; retrying with output bus enabled + silent render callback",
                                serde_json::json!({ "error": first_err }),
                            );
                            match configure_and_init_vpio(true, state_guard.as_ptr()) {
                                Ok(u) => {
                                    (u, "macOS VoiceProcessingIO (AEC+BF, duplex)".to_string())
                                }
                                Err(second_err) => {
                                    let _ = ready_tx.send(Err(second_err));
                                    return;
                                }
                            }
                        }
                    };

                if let Err(st) = unit.start() {
                    let _ = ready_tx.send(Err(format!("AudioOutputUnitStart failed (status={st})")));
                    drop(unit);
                    drop(state_guard);
                    return;
                }

                let _ = ready_tx.send(Ok(device_label));
                let _ = stop_rx.recv();

                // Strict shutdown sequence: Stop -> Uninitialize -> Dispose -> free callback Box.
                drop(unit);
                drop(state_guard);
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
                Err("VoiceProcessingIO 启动超时".into())
            }
        }
    }
}

/// Active 16 kHz mono call microphone stream. Dropping stops the capture stream
/// (`VoiceProcessingIO` on macOS or `cpal` fallback) cleanly, shutting off the OS microphone indicator.
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

/// Opens the default microphone (preferring macOS hardware `VoiceProcessingIO` AEC + beamforming
/// with automatic `cpal` fallback), batches 320-sample (20 ms) frames through `LiveCallProcessor`,
/// and delivers enhanced PCM16 + RMS level.
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

    #[cfg(target_os = "macos")]
    let mut vpio_timed_out = false;
    #[cfg(not(target_os = "macos"))]
    let vpio_timed_out = false;

    #[cfg(target_os = "macos")]
    let cap = {
        let vpio_tx = pcm_tx.clone();
        match macos_vpio::spawn_vpio_capture("pocket-call-vpio", failed.clone(), move |_mono, out| {
            if !out.is_empty() {
                let _ = vpio_tx.try_send(out.to_vec());
            }
        }) {
            Ok(res) => {
                // Drop extra sender clone immediately so `dsp_thread` terminates cleanly on stop.
                drop(pcm_tx);
                crate::logging::info(
                    "voice.audio",
                    "macOS VoiceProcessingIO hardware AEC/beamforming engaged",
                    serde_json::json!({ "device": &res.0 }),
                );
                Ok(res)
            }
            Err(vpio_err) => {
                if vpio_err.contains("超时") {
                    vpio_timed_out = true;
                }
                crate::logging::warn(
                    "voice.audio",
                    "macOS VoiceProcessingIO unavailable; falling back to cpal capture",
                    serde_json::json!({ "error": vpio_err }),
                );
                let cpal_res = spawn_cpal_capture("pocket-call-mic", failed.clone(), move |_mono, out| {
                    if !out.is_empty() {
                        let _ = pcm_tx.try_send(out.to_vec());
                    }
                });
                if let Ok((ref dev, _, _)) = cpal_res {
                    crate::logging::info(
                        "voice.audio",
                        "cpal capture fallback engaged",
                        serde_json::json!({ "device": dev }),
                    );
                }
                cpal_res
            }
        }
    };

    #[cfg(not(target_os = "macos"))]
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
            if !vpio_timed_out && e != "麦克风没有响应" {
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_vpio_constants_and_abi_layout() {
        use super::macos_vpio::*;
        use std::mem::{align_of, size_of};

        assert_eq!(K_AUDIO_UNIT_TYPE_OUTPUT, 0x6175_6f75);
        assert_eq!(K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO, 0x7670_696f);
        assert_eq!(K_AUDIO_UNIT_MANUFACTURER_APPLE, 0x6170_706c);
        assert_eq!(K_AUDIO_FORMAT_LINEAR_PCM, 0x6c70_636d);
        assert_eq!(K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO, 2003);
        assert_eq!(K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK, 2005);
        assert_eq!(K_AU_VOICE_IO_PROPERTY_BYPASS_VOICE_PROCESSING, 2100);
        assert_eq!(K_AU_VOICE_IO_PROPERTY_VOICE_PROCESSING_ENABLE_AGC, 2101);

        // Verified against macOS AudioToolbox / CoreAudioTypes 64-bit C ABI.
        assert_eq!(size_of::<AudioComponentDescription>(), 20);
        assert_eq!(align_of::<AudioComponentDescription>(), 4);
        assert_eq!(size_of::<AudioStreamBasicDescription>(), 40);
        assert_eq!(align_of::<AudioStreamBasicDescription>(), 8);
        assert_eq!(size_of::<AudioBuffer>(), 16);
        assert_eq!(align_of::<AudioBuffer>(), 8);
        assert_eq!(size_of::<AudioBufferList>(), 24);
        assert_eq!(align_of::<AudioBufferList>(), 8);
        assert_eq!(size_of::<AURenderCallbackStruct>(), 16);
        assert_eq!(align_of::<AURenderCallbackStruct>(), 8);

        let asbd = make_16k_mono_f32_asbd();
        assert_eq!(asbd.m_sample_rate, 16_000.0);
        assert_eq!(asbd.m_format_id, K_AUDIO_FORMAT_LINEAR_PCM);
        assert_eq!(
            asbd.m_format_flags,
            K_AUDIO_FORMAT_FLAG_IS_FLOAT | K_AUDIO_FORMAT_FLAG_IS_PACKED
        );
        assert_eq!(asbd.m_bytes_per_packet, 4);
        assert_eq!(asbd.m_frames_per_packet, 1);
        assert_eq!(asbd.m_bytes_per_frame, 4);
        assert_eq!(asbd.m_channels_per_frame, 1);
        assert_eq!(asbd.m_bits_per_channel, 32);

        let mut pcm = Vec::new();
        f32_to_pcm16_into(&[0.0, 1.0, -1.0, 2.5, -2.5, f32::NAN, f32::INFINITY], &mut pcm);
        assert_eq!(pcm, vec![0, 32767, -32767, 32767, -32767, 0, 0]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_vpio_silent_render_callback_zeros_buffers_and_sets_silence_flag() {
        use super::macos_vpio::*;

        let mut data = [0.75f32; 64];
        let mut abl = AudioBufferList {
            m_number_buffers: 1,
            m_buffers: [AudioBuffer {
                m_number_channels: 1,
                m_data_byte_size: (data.len() * std::mem::size_of::<f32>()) as u32,
                m_data: data.as_mut_ptr().cast(),
            }],
        };
        let mut flags: u32 = 0;
        let st = unsafe {
            silent_render_cb(
                std::ptr::null_mut(),
                &mut flags,
                std::ptr::null(),
                OUTPUT_BUS,
                data.len() as u32,
                &mut abl,
            )
        };
        assert_eq!(st, NO_ERR);
        assert_ne!(flags & K_AUDIO_UNIT_RENDER_ACTION_OUTPUT_IS_SILENCE, 0);
        assert!(data.iter().all(|&v| v == 0.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_vpio_component_discovery_and_lifecycle_safety() {
        use super::macos_vpio::*;

        // AudioComponentFindNext must locate Apple's VoiceProcessingIO on every macOS host.
        let desc = make_vpio_component_desc();
        let comp = unsafe { AudioComponentFindNext(std::ptr::null_mut(), &desc) };
        assert!(!comp.is_null(), "VoiceProcessingIO AudioComponent not found on macOS");

        // Instantiate & immediately dispose via Drop with zero leaks or crashes.
        let unit = VpioUnit::new().expect("instantiate VoiceProcessingIO AudioUnit");
        assert!(!unit.raw().is_null());
        drop(unit);

        // Verify full configure + initialize + strict drop order (unit disposed BEFORE callback state freed).
        // On headless CI runners with no audio hardware, AudioUnitInitialize may return an OSStatus error;
        // both initialized and hardware-unavailable paths must tear down cleanly with callback state freed last.
        struct DropTracker(Arc<Mutex<Vec<&'static str>>>);
        impl Drop for DropTracker {
            fn drop(&mut self) {
                if let Ok(mut events) = self.0.lock() {
                    events.push("state_dropped");
                }
            }
        }

        let events = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let tracker = DropTracker(events.clone());
        let failed = Arc::new(AtomicBool::new(false));
        let state_guard =
            CallbackStateGuard::new(VpioCallbackState::new(failed, move |_m: &[f32], _p: &[i16]| {
                let _keep = &tracker;
            }));

        let init_res = configure_and_init_vpio(false, state_guard.as_ptr())
            .or_else(|_| configure_and_init_vpio(true, state_guard.as_ptr()));
        if let Ok(unit) = init_res {
            assert!(events.lock().unwrap().is_empty(), "state dropped prematurely while unit alive");
            drop(unit);
            events.lock().unwrap().push("unit_disposed");
        } else {
            events.lock().unwrap().push("unit_init_unavailable");
        }
        drop(state_guard);

        let log = events.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[1], "state_dropped");
    }
}
