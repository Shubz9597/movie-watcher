//! mpv-embed: thin libmpv wrapper with a native child video host.
//! This uses libmpv core API (not render API) to set wid and control playback.
//! Windows uses a child HWND. Linux uses an X11 child Window, so Wayland needs
//! XWayland or a future render-API path.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_uint, c_ulong, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::OnceLock;
use libloading::Library;

#[allow(non_camel_case_types)]
type mpv_handle = *mut c_void;

#[allow(non_camel_case_types)]
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
type MpvTerminateDestroy = unsafe extern "C" fn(handle: mpv_handle);
type MpvInitialize = unsafe extern "C" fn(handle: mpv_handle) -> c_int;
type MpvSetOption = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, format: mpv_format, data: *const c_void) -> c_int;
type MpvSetOptionString = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, data: *const c_char) -> c_int;
type MpvSetProperty = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, format: mpv_format, data: *const c_void) -> c_int;
type MpvGetProperty = unsafe extern "C" fn(handle: mpv_handle, name: *const c_char, format: mpv_format, data: *mut c_void) -> c_int;
type MpvCommand = unsafe extern "C" fn(handle: mpv_handle, args: *const *const c_char) -> c_int;
type MpvFree = unsafe extern "C" fn(data: *mut c_void);

struct MpvFunctions {
  create: MpvCreate,
  terminate_destroy: MpvTerminateDestroy,
  initialize: MpvInitialize,
  set_option: MpvSetOption,
  set_option_string: MpvSetOptionString,
  set_property: MpvSetProperty,
  get_property: MpvGetProperty,
  command: MpvCommand,
  free: MpvFree,
  _lib: Library, // Keep library loaded
}

static MPV_FUNCS: OnceLock<std::result::Result<MpvFunctions, String>> = OnceLock::new();

unsafe fn load_symbols_from_lib(lib: Library) -> std::result::Result<MpvFunctions, String> {
  let create = lib.get::<MpvCreate>(b"mpv_create\0")
    .map_err(|e| format!("mpv_create: {}", e))?;
  let terminate_destroy = lib.get::<MpvTerminateDestroy>(b"mpv_terminate_destroy\0")
    .map_err(|e| format!("mpv_terminate_destroy: {}", e))?;
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
  let free = lib.get::<MpvFree>(b"mpv_free\0")
    .map_err(|e| format!("mpv_free: {}", e))?;
  
  Ok(MpvFunctions {
    create: *create,
    terminate_destroy: *terminate_destroy,
    initialize: *initialize,
    set_option: *set_option,
    set_option_string: *set_option_string,
    set_property: *set_property,
    get_property: *get_property,
    command: *command,
    free: *free,
    _lib: lib,
  })
}

fn load_mpv_library() -> std::result::Result<MpvFunctions, String> {
    #[cfg(target_os = "windows")]
    let lib_names = ["libmpv-2.dll", "mpv.dll", "libmpv.dll"];
    #[cfg(target_os = "linux")]
    let lib_names = ["libmpv.so.2", "libmpv.so.1", "libmpv.so"];
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let lib_names = ["libmpv.so"];

    let mut last_err = None;
    
    // Build search paths: current dir, exe dir, exe dir/../resources/mpv-sdk, project root mpv-sdk
    let mut search_paths = Vec::new();
    search_paths.push(PathBuf::from("."));
    
    // Try to get executable directory
    if let Ok(exe_path) = std::env::current_exe() {
      if let Some(exe_dir) = exe_path.parent() {
        search_paths.push(exe_dir.to_path_buf());
        // Electron resources directory (for packaged app)
        let mpv_sdk = exe_dir.join("resources").join("mpv-sdk");
        if mpv_sdk.exists() {
          search_paths.push(mpv_sdk);
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
        // Also check for electron-app/mpv-sdk (new Electron app structure)
        let electron_app_mpv_sdk = parent.join("electron-app").join("mpv-sdk");
        if electron_app_mpv_sdk.exists() {
          search_paths.push(electron_app_mpv_sdk);
        }
      }
      // Check if we're in electron-app directory
      if current_dir.ends_with("electron-app") {
        let electron_app_mpv_sdk = current_dir.join("mpv-sdk");
        if electron_app_mpv_sdk.exists() {
          search_paths.push(electron_app_mpv_sdk);
        }
      }
    }
    
    for lib_name in &lib_names {
      // First try loading by name only (searches PATH and current dir)
      match unsafe { Library::new(lib_name) } {
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
            let lib_path = search_path.join(lib_name);
            if lib_path.exists() {
              match unsafe { Library::new(lib_path.as_os_str()) } {
                Ok(lib) => {
                  match unsafe { load_symbols_from_lib(lib) } {
                    Ok(funcs) => return Ok(funcs),
                    Err(e) => {
                      last_err = Some(format!("Failed to load symbols from {}: {}", lib_path.display(), e));
                      continue;
                    }
                  }
                }
                Err(e) => {
                  last_err = Some(format!("Failed to load {} from {}: {}", lib_name, lib_path.display(), e));
                }
              }
            }
          }
        }
      }
    }
    Err(last_err.unwrap_or_else(|| "No libmpv shared library found".to_string()))
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

#[cfg(target_os = "windows")]
mod platform_host {
  use super::*;
  use std::mem::size_of;

  type HWND = *mut c_void;
  type HINSTANCE = *mut c_void;
  type HMENU = *mut c_void;
  type HICON = *mut c_void;
  type HCURSOR = *mut c_void;
  type HBRUSH = *mut c_void;
  type LPCWSTR = *const u16;
  type UINT = u32;
  type DWORD = u32;
  type BOOL = i32;
  type ATOM = u16;
  type WPARAM = usize;
  type LPARAM = isize;
  type LRESULT = isize;

  const WS_CHILD: DWORD = 0x4000_0000;
  const WS_VISIBLE: DWORD = 0x1000_0000;
  const WS_CLIPSIBLINGS: DWORD = 0x0400_0000;
  const WS_CLIPCHILDREN: DWORD = 0x0200_0000;
  const SW_HIDE: c_int = 0;
  const SW_SHOW: c_int = 5;
  const SWP_NOACTIVATE: UINT = 0x0010;
  const SWP_NOOWNERZORDER: UINT = 0x0200;
  const SWP_SHOWWINDOW: UINT = 0x0040;
  const HWND_TOP: HWND = 0 as HWND;

  #[repr(C)]
  struct WNDCLASSEXW {
    cbSize: UINT,
    style: UINT,
    lpfnWndProc: Option<unsafe extern "system" fn(HWND, UINT, WPARAM, LPARAM) -> LRESULT>,
    cbClsExtra: c_int,
    cbWndExtra: c_int,
    hInstance: HINSTANCE,
    hIcon: HICON,
    hCursor: HCURSOR,
    hbrBackground: HBRUSH,
    lpszMenuName: LPCWSTR,
    lpszClassName: LPCWSTR,
    hIconSm: HICON,
  }

  #[link(name = "user32")]
  extern "system" {
    fn RegisterClassExW(lpWndClass: *const WNDCLASSEXW) -> ATOM;
    fn CreateWindowExW(
      dwExStyle: DWORD,
      lpClassName: LPCWSTR,
      lpWindowName: LPCWSTR,
      dwStyle: DWORD,
      x: c_int,
      y: c_int,
      nWidth: c_int,
      nHeight: c_int,
      hWndParent: HWND,
      hMenu: HMENU,
      hInstance: HINSTANCE,
      lpParam: *mut c_void,
    ) -> HWND;
    fn DefWindowProcW(hWnd: HWND, msg: UINT, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    fn DestroyWindow(hWnd: HWND) -> BOOL;
    fn MoveWindow(hWnd: HWND, x: c_int, y: c_int, nWidth: c_int, nHeight: c_int, bRepaint: BOOL) -> BOOL;
    fn ShowWindow(hWnd: HWND, nCmdShow: c_int) -> BOOL;
    fn SetWindowPos(hWnd: HWND, hWndInsertAfter: HWND, x: c_int, y: c_int, cx: c_int, cy: c_int, uFlags: UINT) -> BOOL;
  }

  #[link(name = "kernel32")]
  extern "system" {
    fn GetModuleHandleW(lpModuleName: LPCWSTR) -> HINSTANCE;
  }

  static REGISTERED: OnceLock<std::result::Result<(), String>> = OnceLock::new();

  unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: UINT, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
  }

  fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
  }

  fn parse_hwnd(value: &str) -> Result<HWND> {
    let parsed = value
      .trim()
      .parse::<usize>()
      .map_err(|e| Error::from_reason(format!("Invalid HWND value: {e}")))?;
    Ok(parsed as HWND)
  }

  fn ensure_class() -> Result<()> {
    match REGISTERED.get_or_init(|| unsafe {
      let class_name = wide("MovieWatcherMpvVideoHost");
      let instance = GetModuleHandleW(ptr::null());
      let wc = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as UINT,
        style: 0,
        lpfnWndProc: Some(wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: ptr::null_mut(),
        hCursor: ptr::null_mut(),
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: ptr::null_mut(),
      };
      let atom = RegisterClassExW(&wc);
      if atom == 0 {
        Err("RegisterClassExW failed".to_string())
      } else {
        Ok(())
      }
    }) {
      Ok(()) => Ok(()),
      Err(e) => Err(Error::from_reason(e.clone())),
    }
  }

  pub fn create(parent_window: String, x: i32, y: i32, width: i32, height: i32) -> Result<String> {
    ensure_class()?;
    let parent = parse_hwnd(&parent_window)?;
    unsafe {
      let class_name = wide("MovieWatcherMpvVideoHost");
      let title = wide("MovieWatcher MPV Video Host");
      let instance = GetModuleHandleW(ptr::null());
      let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        title.as_ptr(),
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        x,
        y,
        width.max(1),
        height.max(1),
        parent,
        ptr::null_mut(),
        instance,
        ptr::null_mut(),
      );
      if hwnd.is_null() {
        return Err(Error::from_reason("CreateWindowExW failed for MPV video host"));
      }
      ShowWindow(hwnd, SW_SHOW);
      SetWindowPos(
        hwnd,
        HWND_TOP,
        x,
        y,
        width.max(1),
        height.max(1),
        SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
      );
      Ok((hwnd as usize).to_string())
    }
  }

  pub fn resize(window_id: String, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
    let hwnd = parse_hwnd(&window_id)?;
    unsafe {
      MoveWindow(hwnd, x, y, width.max(1), height.max(1), 1);
      SetWindowPos(
        hwnd,
        HWND_TOP,
        x,
        y,
        width.max(1),
        height.max(1),
        SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
      );
    }
    Ok(())
  }

  pub fn show(window_id: String, visible: bool) -> Result<()> {
    let hwnd = parse_hwnd(&window_id)?;
    unsafe {
      ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
    }
    Ok(())
  }

  pub fn destroy(window_id: String) -> Result<()> {
    let hwnd = parse_hwnd(&window_id)?;
    unsafe {
      DestroyWindow(hwnd);
    }
    Ok(())
  }
}

#[cfg(target_os = "linux")]
mod platform_host {
  use super::*;

  #[link(name = "X11")]
  extern "C" {
    fn XOpenDisplay(display_name: *const c_char) -> *mut c_void;
    fn XDefaultScreen(display: *mut c_void) -> c_int;
    fn XBlackPixel(display: *mut c_void, screen_number: c_int) -> c_ulong;
    fn XCreateSimpleWindow(
      display: *mut c_void,
      parent: c_ulong,
      x: c_int,
      y: c_int,
      width: c_uint,
      height: c_uint,
      border_width: c_uint,
      border: c_ulong,
      background: c_ulong,
    ) -> c_ulong;
    fn XMapRaised(display: *mut c_void, window: c_ulong) -> c_int;
    fn XUnmapWindow(display: *mut c_void, window: c_ulong) -> c_int;
    fn XMoveResizeWindow(display: *mut c_void, window: c_ulong, x: c_int, y: c_int, width: c_uint, height: c_uint) -> c_int;
    fn XDestroyWindow(display: *mut c_void, window: c_ulong) -> c_int;
    fn XFlush(display: *mut c_void) -> c_int;
    fn XCloseDisplay(display: *mut c_void) -> c_int;
  }

  fn parse_xid(value: &str) -> Result<c_ulong> {
    value
      .trim()
      .parse::<u64>()
      .map(|v| v as c_ulong)
      .map_err(|e| Error::from_reason(format!("Invalid X11 window id: {e}")))
  }

  fn with_display<T>(f: impl FnOnce(*mut c_void) -> Result<T>) -> Result<T> {
    if std::env::var_os("DISPLAY").is_none() {
      return Err(Error::from_reason("DISPLAY is not set; MPV wid embedding on Linux requires X11 or XWayland"));
    }
    unsafe {
      let display = XOpenDisplay(ptr::null());
      if display.is_null() {
        return Err(Error::from_reason("XOpenDisplay failed"));
      }
      let result = f(display);
      XFlush(display);
      XCloseDisplay(display);
      result
    }
  }

  pub fn create(parent_window: String, x: i32, y: i32, width: i32, height: i32) -> Result<String> {
    let parent = parse_xid(&parent_window)?;
    with_display(|display| unsafe {
      let screen = XDefaultScreen(display);
      let black = XBlackPixel(display, screen);
      let xid = XCreateSimpleWindow(
        display,
        parent,
        x,
        y,
        width.max(1) as c_uint,
        height.max(1) as c_uint,
        0,
        black,
        black,
      );
      if xid == 0 {
        return Err(Error::from_reason("XCreateSimpleWindow failed for MPV video host"));
      }
      XMapRaised(display, xid);
      Ok((xid as u64).to_string())
    })
  }

  pub fn resize(window_id: String, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
    let xid = parse_xid(&window_id)?;
    with_display(|display| unsafe {
      XMoveResizeWindow(display, xid, x, y, width.max(1) as c_uint, height.max(1) as c_uint);
      XMapRaised(display, xid);
      Ok(())
    })
  }

  pub fn show(window_id: String, visible: bool) -> Result<()> {
    let xid = parse_xid(&window_id)?;
    with_display(|display| unsafe {
      if visible {
        XMapRaised(display, xid);
      } else {
        XUnmapWindow(display, xid);
      }
      Ok(())
    })
  }

  pub fn destroy(window_id: String) -> Result<()> {
    let xid = parse_xid(&window_id)?;
    with_display(|display| unsafe {
      XDestroyWindow(display, xid);
      Ok(())
    })
  }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
mod platform_host {
  use super::*;

  pub fn create(_parent_window: String, _x: i32, _y: i32, _width: i32, _height: i32) -> Result<String> {
    Err(Error::from_reason("Native MPV video host is only implemented for Windows and Linux/X11"))
  }

  pub fn resize(_window_id: String, _x: i32, _y: i32, _width: i32, _height: i32) -> Result<()> {
    Ok(())
  }

  pub fn show(_window_id: String, _visible: bool) -> Result<()> {
    Ok(())
  }

  pub fn destroy(_window_id: String) -> Result<()> {
    Ok(())
  }
}

#[napi]
pub fn create_video_host(parent_window: String, x: i32, y: i32, width: i32, height: i32) -> Result<String> {
  platform_host::create(parent_window, x, y, width, height)
}

#[napi]
pub fn resize_video_host(window_id: String, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
  platform_host::resize(window_id, x, y, width, height)
}

#[napi]
pub fn show_video_host(window_id: String, visible: bool) -> Result<()> {
  platform_host::show(window_id, visible)
}

#[napi]
pub fn destroy_video_host(window_id: String) -> Result<()> {
  platform_host::destroy(window_id)
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
      Ok(MpvHandle { handle: h, attached: false })
    }
  }

  #[napi]
  pub fn init(&self, _options: Option<Object>) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      // wid must already be set via attach_window / attach_hwnd before init.
      let mut opts = vec![
        ("force-window", "yes"),
        ("keep-open", "yes"),
        ("ytdl", "no"),
        ("vo", "gpu"),
        ("hwdec", "auto-safe"),
        ("video-sync", "display-resample"),
        // Prefer a full-bleed player surface over thin letterbox seams. MPV
        // crops only the overflow required by the source/window aspect ratio.
        ("panscan", "1.0"),
      ];

      #[cfg(target_os = "windows")]
      {
        // Let mpv choose the best GPU backend for the child HWND. Forcing the
        // old direct3d VO can produce audio-only output with Electron-hosted UI.
        opts.push(("gpu-api", "auto"));
      }

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

  fn attach_window_id(&mut self, window_id: String, label: &str) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("wid").unwrap();
      let window_id_u32: u32 = window_id
        .trim()
        .parse::<u32>()
        .map_err(|e| Error::from_reason(format!("Invalid {label} (expected an unsigned 32-bit Windows/X11 ID): {e}")))?;
      let window_id64 = i64::from(window_id_u32);

      // wid is an option. It must be set before mpv_initialize.
      let opt_result = (funcs.set_option)(
        self.handle,
        key.as_ptr(),
        mpv_format::MPV_FORMAT_INT64,
        &window_id64 as *const i64 as *const c_void,
      );
      
      if opt_result < 0 {
        return Err(Error::from_reason(format!(
          "Failed to set wid option: result={}, {}={}",
          opt_result, label, window_id_u32
        )));
      }
      eprintln!("[mpv-native] set_option wid succeeded: {} ({}={})", opt_result, label, window_id_u32);
      self.attached = true;
      Ok(())
    }
  }

  /// Attach to a native child video host. Windows passes an HWND, Linux passes an X11 Window id.
  #[napi]
  pub fn attach_window(&mut self, window_id: String) -> Result<()> {
    self.attach_window_id(window_id, "window_id")
  }

  /// Backward-compatible Windows name. Prefer attach_window for new callers.
  #[napi]
  pub fn attach_hwnd(&mut self, hwnd: String) -> Result<()> {
    self.attach_window_id(hwnd, "hwnd")
  }

  #[napi]
  pub fn load(&self, url: String, start_seconds: Option<f64>) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let c_url = CString::new(url).unwrap();
      let load = CString::new("loadfile").unwrap();
      let replace = CString::new("replace").unwrap();
      if let Some(start_seconds) = start_seconds {
        if !start_seconds.is_finite() || start_seconds < 0.0 {
          return Err(Error::from_reason(
            "start_seconds must be a finite, non-negative number",
          ));
        }

        // mpv 0.38+ places per-file options after an insertion index. Passing
        // the resume position here makes mpv apply it as part of loading the
        // file, instead of racing a seek command against demuxer startup.
        let index = CString::new("-1").unwrap();
        let options = CString::new(format!("start={start_seconds:.3}")).unwrap();
        let args: [*const c_char; 6] = [
          load.as_ptr(),
          c_url.as_ptr(),
          replace.as_ptr(),
          index.as_ptr(),
          options.as_ptr(),
          ptr::null(),
        ];
        check_err((funcs.command)(self.handle, args.as_ptr()), "loadfile")
      } else {
        let args: [*const c_char; 4] = [load.as_ptr(), c_url.as_ptr(), replace.as_ptr(), ptr::null()];
        check_err((funcs.command)(self.handle, args.as_ptr()), "loadfile")
      }
    }
  }

  /// Force mpv to reload the video output (useful when window becomes visible)
  #[napi]
  pub fn reload_video_output(&self) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      // Try to reload video output by setting vo property
      // This forces mpv to recreate the rendering context
      let vo_reload = CString::new("vo-reload").unwrap();
      let args: [*const c_char; 2] = [vo_reload.as_ptr(), ptr::null()];
      // This command might not exist, so we don't fail if it errors
      let _ = (funcs.command)(self.handle, args.as_ptr());
      Ok(())
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
  pub fn shutdown(&mut self) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      if !self.handle.is_null() {
        // mpv_destroy may return while the playback core and video output are
        // still winding down. Reopening immediately can then collide with the
        // old HWND/VO. terminate_destroy waits for complete core teardown.
        (funcs.terminate_destroy)(self.handle);
        self.handle = ptr::null_mut();
      }
    }
    Ok(())
  }

  /// Apply a runtime video framing mode. Aspect uses MPV values such as "-1"
  /// (source), "16:9", "4:3", or "2.35:1". Panscan fills aspect mismatch;
  /// zoom handles black bars that are encoded into the video pixels.
  #[napi]
  pub fn set_aspect_mode(&self, aspect: String, panscan: f64, zoom: f64) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let values = [
        ("video-aspect-override", aspect),
        ("panscan", panscan.clamp(0.0, 1.0).to_string()),
        ("video-zoom", zoom.clamp(-1.0, 1.0).to_string()),
      ];

      for (property, value) in values {
        let set = CString::new("set").unwrap();
        let property_c = CString::new(property).unwrap();
        let value_c = CString::new(value).map_err(|e| Error::from_reason(e.to_string()))?;
        let args: [*const c_char; 4] = [
          set.as_ptr(),
          property_c.as_ptr(),
          value_c.as_ptr(),
          ptr::null(),
        ];
        check_err((funcs.command)(self.handle, args.as_ptr()), property)?;
      }
      Ok(())
    }
  }

  /// Shift audio relative to video. Positive values play audio later.
  #[napi]
  pub fn set_audio_delay(&self, seconds: f64) -> Result<()> {
    self.set_delay_property("audio-delay", seconds)
  }

  /// Shift subtitles relative to video. Positive values show subtitles later.
  #[napi]
  pub fn set_subtitle_delay(&self, seconds: f64) -> Result<()> {
    self.set_delay_property("sub-delay", seconds)
  }

  fn set_delay_property(&self, property: &str, seconds: f64) -> Result<()> {
    if !seconds.is_finite() {
      return Err(Error::from_reason(format!("{property} must be a finite number")));
    }

    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new(property).unwrap();
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_DOUBLE,
          &seconds as *const f64 as *const c_void,
        ),
        property,
      )
    }
  }

  /// Get the current wid (window ID) that mpv is using
  #[napi]
  pub fn get_wid(&self) -> Result<Option<String>> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("wid").unwrap();
      let mut wid: i64 = 0;
      let result = (funcs.get_property)(
        self.handle,
        key.as_ptr(),
        mpv_format::MPV_FORMAT_INT64,
        &mut wid as *mut i64 as *mut c_void,
      );
      if result < 0 {
        Ok(None)
      } else {
        Ok(Some((wid as u64).to_string()))
      }
    }
  }

  /// Get the current video output driver being used
  #[napi]
  pub fn get_vo(&self) -> Result<Option<String>> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("vo").unwrap();
      let mut vo: *mut c_char = ptr::null_mut();
      let result = (funcs.get_property)(
        self.handle,
        key.as_ptr(),
        mpv_format::MPV_FORMAT_STRING,
        &mut vo as *mut *mut c_char as *mut c_void,
      );
      if result < 0 {
        Ok(None)
      } else {
        let vo_str = if vo.is_null() {
          None
        } else {
          let value = std::ffi::CStr::from_ptr(vo).to_string_lossy().into_owned();
          (funcs.free)(vo as *mut c_void);
          Some(value)
        };
        Ok(vo_str)
      }
    }
  }

  /// Minimal state poll for the controls overlay.
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
      let mut eof_reached: i32 = 0;
      let mut paused_for_cache: i32 = 0;
      let mut audio_delay: f64 = 0.0;
      let mut subtitle_delay: f64 = 0.0;
      let mut video_format: *mut c_char = ptr::null_mut();
      let p_pause = CString::new("pause").unwrap();
      let p_time = CString::new("time-pos").unwrap();
      let p_duration = CString::new("duration").unwrap();
      let p_volume = CString::new("volume").unwrap();
      let p_mute = CString::new("mute").unwrap();
      let p_eof_reached = CString::new("eof-reached").unwrap();
      let p_paused_for_cache = CString::new("paused-for-cache").unwrap();
      let p_audio_delay = CString::new("audio-delay").unwrap();
      let p_subtitle_delay = CString::new("sub-delay").unwrap();
      let p_video_format = CString::new("video-format").unwrap();
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
      let _ = (funcs.get_property)(
        self.handle,
        p_eof_reached.as_ptr(),
        mpv_format::MPV_FORMAT_FLAG,
        &mut eof_reached as *mut i32 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_paused_for_cache.as_ptr(),
        mpv_format::MPV_FORMAT_FLAG,
        &mut paused_for_cache as *mut i32 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_audio_delay.as_ptr(),
        mpv_format::MPV_FORMAT_DOUBLE,
        &mut audio_delay as *mut f64 as *mut c_void,
      );
      let _ = (funcs.get_property)(
        self.handle,
        p_subtitle_delay.as_ptr(),
        mpv_format::MPV_FORMAT_DOUBLE,
        &mut subtitle_delay as *mut f64 as *mut c_void,
      );
      let video_format_result = (funcs.get_property)(
        self.handle,
        p_video_format.as_ptr(),
        mpv_format::MPV_FORMAT_STRING,
        &mut video_format as *mut *mut c_char as *mut c_void,
      );
      let video_format_value = if video_format_result >= 0 && !video_format.is_null() {
        let value = std::ffi::CStr::from_ptr(video_format).to_string_lossy().into_owned();
        (funcs.free)(video_format as *mut c_void);
        value
      } else {
        String::new()
      };
      obj.set("ready", true)?;
      obj.set("videoFormat", video_format_value)?;
      obj.set("paused", paused != 0)?;
      obj.set("time", time)?;
      obj.set("duration", duration)?;
      obj.set("volume", volume)?;
      obj.set("mute", mute != 0)?;
      obj.set("eofReached", eof_reached != 0)?;
      obj.set("buffering", paused_for_cache != 0)?;
      obj.set("audioDelay", audio_delay)?;
      obj.set("subtitleDelay", subtitle_delay)?;
    }
    Ok(obj)
  }

  /// Load a subtitle file
  #[napi]
  pub fn load_subtitle(&self, url: String) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let sub_add = CString::new("sub-add").unwrap();
      let c_url = CString::new(url).unwrap();
      let select = CString::new("select").unwrap();
      let args: [*const c_char; 4] = [sub_add.as_ptr(), c_url.as_ptr(), select.as_ptr(), ptr::null()];
      check_err((funcs.command)(self.handle, args.as_ptr()), "sub-add")
    }
  }

  /// Set the active audio track by index
  #[napi]
  pub fn set_audio_track(&self, index: i32) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("aid").unwrap();
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_INT64,
          &(index as i64) as *const i64 as *const c_void,
        ),
        "aid",
      )
    }
  }

  /// Set the active subtitle track by index (-1 to disable)
  #[napi]
  pub fn set_subtitle_track(&self, index: i32) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      if index < 0 {
        let set = CString::new("set").unwrap();
        let key = CString::new("sid").unwrap();
        let no = CString::new("no").unwrap();
        let args: [*const c_char; 4] = [set.as_ptr(), key.as_ptr(), no.as_ptr(), ptr::null()];
        return check_err((funcs.command)(self.handle, args.as_ptr()), "sid");
      }
      let key = CString::new("sid").unwrap();
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_INT64,
          &(index as i64) as *const i64 as *const c_void,
        ),
        "sid",
      )
    }
  }

  /// Set playback speed (1.0 = normal, 2.0 = 2x, 0.5 = half speed)
  #[napi]
  pub fn set_speed(&self, speed: f64) -> Result<()> {
    let funcs = get_mpv_funcs()?;
    unsafe {
      let key = CString::new("speed").unwrap();
      check_err(
        (funcs.set_property)(
          self.handle,
          key.as_ptr(),
          mpv_format::MPV_FORMAT_DOUBLE,
          &speed as *const f64 as *const c_void,
        ),
        "speed",
      )
    }
  }
}

impl Drop for MpvHandle {
  fn drop(&mut self) {
    if let Ok(funcs) = get_mpv_funcs() {
      unsafe {
        if !self.handle.is_null() {
          (funcs.terminate_destroy)(self.handle);
        }
      }
    }
  }
}
