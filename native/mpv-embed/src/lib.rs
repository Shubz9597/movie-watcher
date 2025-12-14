//! mpv-embed: thin libmpv wrapper (Windows-first, HWND target)
//! This uses libmpv core API (not render API) to set wid and control playback.
//! It expects libmpv-2.dll to be available via PATH or alongside the app.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::OnceLock;
use libloading::Library;

#[allow(non_camel_case_types)]
type mpv_handle = *mut c_void;

#[allow(non_camel_case_types)]
type mpv_log_level = c_int;

#[repr(C)]
#[allow(non_camel_case_types)]
enum mpv_format {
  MPV_FORMAT_NONE = 0,
  MPV_FORMAT_STRING = 1,
  MPV_FORMAT_OSD_STRING = 2,
  MPV_FORMAT_FLAG = 3,
  MPV_FORMAT_INT64 = 4,
  MPV_FORMAT_DOUBLE = 5,
  MPV_FORMAT_NODE = 7,
}

// Function pointer types
type MpvCreate = unsafe extern "C" fn() -> mpv_handle;
type MpvDestroy = unsafe extern "C" fn(handle: mpv_handle);
type MpvInitialize = unsafe extern "C" fn(handle: mpv_handle) -> c_int;
type MpvSetOption = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, format: mpv_format, data: *const c_void) -> c_int;
type MpvSetOptionString = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, data: *const c_char) -> c_int;
type MpvSetProperty = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, format: mpv_format, data: *const c_void) -> c_int;
type MpvGetProperty = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, format: mpv_format, data: *mut c_void) -> c_int;
type MpvCommand = unsafe extern "C" fn(handle: mpv_handle, args: *const *const c_char) -> c_int;
type MpvSetLogLevel = unsafe extern "C" fn(handle: mpv_handle, level: mpv_log_level) -> c_int;

struct MpvFunctions {
  create: MpvCreate,
  destroy: MpvDestroy,
  initialize: MpvInitialize,
  set_option: MpvSetOption,
  set_option_string: MpvSetOptionString,
  set_property: MpvSetProperty,
  get_property: MpvGetProperty,
  command: MpvCommand,
  set_log_level: Option<MpvSetLogLevel>, // Optional - may not be available in all DLL versions
  _lib: Library, // Keep library loaded
}

static MPV_FUNCS: OnceLock<std::result::Result<MpvFunctions, String>> = OnceLock::new();

unsafe fn load_symbols_from_lib(lib: Library) -> std::result::Result<MpvFunctions, String> {
  let create = lib.get::<MpvCreate>(b"mpv_create\0")
    .map_err(|e| format!("mpv_create: {}", e))?;
  let destroy = lib.get::<MpvDestroy>(b"mpv_destroy\0")
    .map_err(|e| format!("mpv_destroy: {}", e))?;
  let initialize = lib.get::<MpvInitialize>(b"mpv_initialize\0")
    .map_err(|e| format!("mpv_initialize: {}", e))?;
  let set_option = lib.get::<MpvSetOption>(b"mpv_set_option\0")
    .map_err(|e| format!("mpv_set_option: {}", e))?;
  let set_option_string = lib.get::<MpvSetOptionString>(b"mpv_set_option_string\0")
    .map_err(|e| format!("mpv_set_option_string: {}", e))?;
  let set_property = lib.get::<MpvSetProperty>(b"mpv_set_property\0")
    .map_err(|e| format!("mpv_set_property: {}", e))?;
  let get_property = lib.get::<MpvGetProperty>(b"mpv_get_property\0")
    .map_err(|e| format!("mpv_get_property: {}", e))?;
  let command = lib.get::<MpvCommand>(b"mpv_command\0")
    .map_err(|e| format!("mpv_command: {}", e))?;
  // mpv_set_log_level is optional - may not be available in all DLL versions
  let set_log_level = lib.get::<MpvSetLogLevel>(b"mpv_set_log_level\0").ok().map(|s| *s);
  
  Ok(MpvFunctions {
    create: *create,
    destroy: *destroy,
    initialize: *initialize,
    set_option: *set_option,
    set_option_string: *set_option_string,
    set_property: *set_property,
    get_property: *get_property,
    command: *command,
    set_log_level,
    _lib: lib,
  })
}

fn load_mpv_library() -> std::result::Result<MpvFunctions, String> {
    // Try common DLL names on Windows
    let dll_names = ["libmpv-2.dll", "mpv.dll", "libmpv.dll"];
    let mut last_err = None;
    
    // Build search paths: current dir, exe dir, exe dir/../resources/mpv-sdk, project root mpv-sdk
    let mut search_paths = Vec::new();
    search_paths.push(PathBuf::from("."));
    
    // Try to get executable directory
    if let Ok(exe_path) = std::env::current_exe() {
      if let Some(exe_dir) = exe_path.parent() {
        search_paths.push(exe_dir.to_path_buf());
        // Electron resources directory (for packaged app)
        if let Some(resources_dir) = exe_dir.parent() {
          let mpv_sdk = resources_dir.join("resources").join("mpv-sdk");
          if mpv_sdk.exists() {
            search_paths.push(mpv_sdk);
          }
        }
      }
    }
    
    // Also search in project root mpv-sdk (for development)
    if let Ok(current_dir) = std::env::current_dir() {
      let dev_mpv_sdk = current_dir.join("mpv-sdk");
      if dev_mpv_sdk.exists() {
        search_paths.push(dev_mpv_sdk);
      }
      // Also try parent directory (in case we're in electron/ or native/mpv-embed/)
      if let Some(parent) = current_dir.parent() {
        let parent_mpv_sdk = parent.join("mpv-sdk");
        if parent_mpv_sdk.exists() {
          search_paths.push(parent_mpv_sdk);
        }
      }
    }
    
    for dll_name in &dll_names {
      // First try loading by name only (searches PATH and current dir)
      match unsafe { Library::new(dll_name) } {
        Ok(lib) => {
          match unsafe { load_symbols_from_lib(lib) } {
            Ok(funcs) => return Ok(funcs),
            Err(e) => {
              last_err = Some(e);
              continue;
            }
          }
        }
        Err(_) => {
          // If loading by name failed, try explicit paths
          for search_path in &search_paths {
            let dll_path = search_path.join(dll_name);
            if dll_path.exists() {
              match unsafe { Library::new(dll_path.as_os_str()) } {
                Ok(lib) => {
                  match unsafe { load_symbols_from_lib(lib) } {
                    Ok(funcs) => return Ok(funcs),
                    Err(e) => {
                      last_err = Some(format!("Failed to load symbols from {}: {}", dll_path.display(), e));
                      continue;
                    }
                  }
                }
                Err(e) => {
                  last_err = Some(format!("Failed to load {} from {}: {}", dll_name, dll_path.display(), e));
                }
              }
            }
          }
        }
      }
    }
    Err(last_err.unwrap_or_else(|| "No mpv DLL found".to_string()))
}

fn get_mpv_funcs() -> Result<&'static MpvFunctions> {
  let result = MPV_FUNCS.get_or_init(load_mpv_library);
  match result {
    Ok(funcs) => Ok(funcs),
    Err(e) => Err(Error::from_reason(e.clone())),
  }
}

fn check_err(code: c_int, ctx: &str) -> Result<()> {
  if code < 0 {
    Err(Error::from_reason(format!("mpv error {}: {}", code, ctx)))
  } else {
    Ok(())
  }
}

#[napi]
pub struct MpvHandle {
  handle: mpv_handle,
  attached: bool,
}

#[napi]
impl MpvHandle {
  #[napi(factory)]
  pub fn create() -> Result<Self> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let h = (funcs.create)();
      if h.is_null() {
        return Err(Error::from_reason("mpv_create failed"));
      }
      // quiet logging (if available)
      if let Some(set_log_level) = funcs.set_log_level {
        let _ = set_log_level(h, 0);
      }
      Ok(MpvHandle { handle: h, attached: false })
    }
  }

  #[napi]
  pub fn init(&self, _options: Option<Object>) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      // Video output options (set before init)
      // Note: wid should already be set via attach_hwnd before calling init
      // Video output options - try gpu first, fallback to direct3d if needed
      // wid should already be set via attach_hwnd
      let opts = [
        ("force-window", "yes"),
        ("keep-open", "yes"),
        ("ytdl", "no"),
        ("vo", "gpu"), // Use gpu VO with wid for hardware acceleration
        ("gpu-context", "d3d11"), // Direct3D 11 context for Windows
        ("hwdec", "auto-safe"), // Hardware decoding
        ("video-sync", "display-resample"), // Sync to display
      ];
      for (k, v) in opts {
        let ck = CString::new(k).unwrap();
        let cv = CString::new(v).unwrap();
        check_err((funcs.set_option_string)(self.handle, ck.as_ptr(), cv.as_ptr()), k)?;
      }
      check_err((funcs.initialize)(self.handle), "initialize")
    }
  }

  /// Set an mpv string option (must be called before init where applicable).
  #[napi]
  pub fn set_option_string(&self, key: String, value: String) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let ck = CString::new(key).map_err(|e| Error::from_reason(e.to_string()))?;
      let cv = CString::new(value).map_err(|e| Error::from_reason(e.to_string()))?;
      check_err((funcs.set_option_string)(self.handle, ck.as_ptr(), cv.as_ptr()), "set_option_string")
    }
  }

  /// Attach to a native HWND (Windows). This sets the "wid" option.
  #[napi]
  pub fn attach_hwnd(&mut self, hwnd: u32) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("wid").unwrap();
      let hwnd64: i64 = hwnd as i64;
      
      // Try setting as option first (works before init) - CHECK THE RESULT
      let opt_result = (funcs.set_option)(
        self.handle,
        key.as_ptr(),
        mpv_format::MPV_FORMAT_INT64,
        &hwnd64 as *const i64 as *const c_void,
      );
      
      if opt_result < 0 {
        // If setting as option failed, try as property (works after init)
        let prop_key = CString::new("wid").unwrap();
        let prop_result = (funcs.set_property)(
          self.handle,
          prop_key.as_ptr(),
          mpv_format::MPV_FORMAT_INT64,
          &hwnd64 as *const i64 as *const c_void,
        );
        if prop_result < 0 {
          return Err(Error::from_reason(format!(
            "Failed to set wid: option={}, property={}, hwnd={}",
            opt_result, prop_result, hwnd
          )));
        }
        // Property set succeeded
      } else {
        // Option was set successfully, also set as property for redundancy
        let prop_key = CString::new("wid").unwrap();
        let prop_result = (funcs.set_property)(
          self.handle,
          prop_key.as_ptr(),
          mpv_format::MPV_FORMAT_INT64,
          &hwnd64 as *const i64 as *const c_void,
        );
        // Don't fail if property set fails - option was already set
        if prop_result < 0 {
          // Log but don't fail
        }
      }
      self.attached = true;
      Ok(())
    }
  }

  #[napi]
  pub fn load(&self, url: String) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let c_url = CString::new(url).unwrap();
      let load = CString::new("loadfile").unwrap();
      let replace = CString::new("replace").unwrap();
      let args: [*const c_char; 4] = [load.as_ptr(), c_url.as_ptr(), replace.as_ptr(), ptr::null()];
      check_err((funcs.command)(self.handle, args.as_ptr()), "loadfile")
    }
  }

  #[napi]
  pub fn pause(&self, paused: bool) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("pause").unwrap();
      let flag: i32 = if paused { 1 } else { 0 };
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_FLAG,
          &flag as *const i32 as *const c_void,
        ),
        "pause",
      )
    }
  }

  #[napi]
  pub fn seek(&self, seconds: f64, relative: bool) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let seek = CString::new("seek").unwrap();
      let val = CString::new(format!("{seconds}")).unwrap();
      let mode = CString::new(if relative { "relative" } else { "absolute" }).unwrap();
      let args: [*const c_char; 4] = [seek.as_ptr(), val.as_ptr(), mode.as_ptr(), ptr::null()];
      check_err((funcs.command)(self.handle, args.as_ptr()), "seek")
    }
  }

  #[napi]
  pub fn set_volume(&self, volume: f64) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("volume").unwrap();
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_DOUBLE,
          &volume as *const f64 as *const c_void,
        ),
        "volume",
      )
    }
  }

  #[napi]
  pub fn set_mute(&self, mute: bool) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("mute").unwrap();
      let flag: i32 = if mute { 1 } else { 0 };
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_FLAG,
          &flag as *const i32 as *const c_void,
        ),
        "mute",
      )
    }
  }

  #[napi]
  pub fn stop(&self) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let cmd = CString::new("stop").unwrap();
      let args: [*const c_char; 2] = [cmd.as_ptr(), ptr::null()];
      check_err((funcs.command)(self.handle, args.as_ptr()), "stop")
    }
  }

  #[napi]
  pub fn shutdown(&self) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      (funcs.destroy)(self.handle);
    }
    Ok(())
  }

  /// Minimal state poll: paused, time-pos, duration, volume, mute.
  #[napi]
  pub fn get_state(&self, env: Env) -> Result<Object> {
    let funcs = get_mpv_funcs()?;
    let mut obj = env.create_object()?;
    unsafe {
      let mut paused: i32 = 0;
      let mut time: f64 = 0.0;
      let mut duration: f64 = 0.0;
      let mut volume: f64 = 0.0;
      let mut mute: i32 = 0;
      let p_pause = CString::new("pause").unwrap();
      let p_time = CString::new("time-pos").unwrap();
      let p_duration = CString::new("duration").unwrap();
      let p_volume = CString::new("volume").unwrap();
      let p_mute = CString::new("mute").unwrap();
      let _ = (funcs.get_property)(
        self.handle,
        p_pause.as_ptr(),
        mpv_format::MPV_FORMAT_FLAG,
        &mut paused as *mut i32 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_time.as_ptr(),
        mpv_format::MPV_FORMAT_DOUBLE,
        &mut time as *mut f64 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_duration.as_ptr(),
        mpv_format::MPV_FORMAT_DOUBLE,
        &mut duration as *mut f64 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_volume.as_ptr(),
        mpv_format::MPV_FORMAT_DOUBLE,
        &mut volume as *mut f64 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_mute.as_ptr(),
        mpv_format::MPV_FORMAT_FLAG,
        &mut mute as *mut i32 as *mut c_void,
      );
      obj.set("ready", true)?;
      obj.set("paused", paused != 0)?;
      obj.set("time", time)?;
      obj.set("duration", duration)?;
      obj.set("volume", volume)?;
      obj.set("mute", mute != 0)?;
    }
    Ok(obj)
  }
}

impl Drop for MpvHandle {
  fn drop(&mut self) {
    if let Ok(funcs) = get_mpv_funcs() {
      unsafe {
        if !self.handle.is_null() {
          (funcs.destroy)(self.handle);
        }
      }
    }
  }
}
