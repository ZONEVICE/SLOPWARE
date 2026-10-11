//! Raw Win32 FFI declarations.
//!
//! Every `extern "system"` binding the program uses lives here, declared by
//! hand so the project depends on nothing but the Rust standard library (no
//! `windows-sys`). This is the single place where the Win32 ABI is spelled
//! out; the safe wrappers in the sibling modules are the only callers.
//!
//! Types mirror the Win32 headers: `BOOL` is a 32-bit int, `WORD` is `u16`,
//! `DWORD` is `u32`, handles and pointers are pointer-width. Keep the struct
//! layouts byte-exact — a wrong field width here corrupts memory silently.

#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, dead_code)]

use std::ffi::c_void;

pub type BOOL = i32;
pub type WORD = u16;
pub type DWORD = u32;
pub type HANDLE = *mut c_void;
pub type HWND = *mut c_void;
pub type HGLOBAL = *mut c_void;
pub type LONG = i32;
pub type ULONG = u32;
pub type USHORT = u16;
pub type WCHAR = u16;
pub type LPARAM = isize;
pub type WPARAM = usize;
pub type LRESULT = isize;
pub type NTSTATUS = i32;

pub const TRUE: BOOL = 1;
pub const FALSE: BOOL = 0;

// ---------------------------------------------------------------------------
// Console (kernel32)
// ---------------------------------------------------------------------------

pub const STD_OUTPUT_HANDLE: DWORD = -11i32 as DWORD;
pub const STD_INPUT_HANDLE: DWORD = -10i32 as DWORD;
pub const ENABLE_VIRTUAL_TERMINAL_PROCESSING: DWORD = 0x0004;
pub const ENABLE_PROCESSED_OUTPUT: DWORD = 0x0001;
pub const CP_UTF8: DWORD = 65001;

// ---------------------------------------------------------------------------
// Input (user32) — SendInput and friends
// ---------------------------------------------------------------------------

pub const INPUT_MOUSE: DWORD = 0;
pub const INPUT_KEYBOARD: DWORD = 1;

pub const MOUSEEVENTF_MOVE: DWORD = 0x0001;
pub const MOUSEEVENTF_LEFTDOWN: DWORD = 0x0002;
pub const MOUSEEVENTF_LEFTUP: DWORD = 0x0004;
pub const MOUSEEVENTF_RIGHTDOWN: DWORD = 0x0008;
pub const MOUSEEVENTF_RIGHTUP: DWORD = 0x0010;
pub const MOUSEEVENTF_MIDDLEDOWN: DWORD = 0x0020;
pub const MOUSEEVENTF_MIDDLEUP: DWORD = 0x0040;
pub const MOUSEEVENTF_XDOWN: DWORD = 0x0080;
pub const MOUSEEVENTF_XUP: DWORD = 0x0100;
pub const MOUSEEVENTF_WHEEL: DWORD = 0x0800;
pub const MOUSEEVENTF_HWHEEL: DWORD = 0x1000;
pub const MOUSEEVENTF_ABSOLUTE: DWORD = 0x8000;
pub const MOUSEEVENTF_VIRTUALDESK: DWORD = 0x4000;

pub const XBUTTON1: WORD = 0x0001;
pub const XBUTTON2: WORD = 0x0002;

pub const KEYEVENTF_EXTENDEDKEY: DWORD = 0x0001;
pub const KEYEVENTF_KEYUP: DWORD = 0x0002;
pub const KEYEVENTF_UNICODE: DWORD = 0x0004;
pub const KEYEVENTF_SCANCODE: DWORD = 0x0008;

pub const WHEEL_DELTA: i32 = 120;

pub const SM_XVIRTUALSCREEN: i32 = 76;
pub const SM_YVIRTUALSCREEN: i32 = 77;
pub const SM_CXVIRTUALSCREEN: i32 = 78;
pub const SM_CYVIRTUALSCREEN: i32 = 79;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct POINT {
    pub x: LONG,
    pub y: LONG,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MOUSEINPUT {
    pub dx: LONG,
    pub dy: LONG,
    pub mouseData: DWORD,
    pub dwFlags: DWORD,
    pub time: DWORD,
    pub dwExtraInfo: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct KEYBDINPUT {
    pub wVk: WORD,
    pub wScan: WORD,
    pub dwFlags: DWORD,
    pub time: DWORD,
    pub dwExtraInfo: usize,
}

/// The `INPUT` union is modelled as a struct whose payload is wide enough for
/// the largest member (`MOUSEINPUT`). `SendInput` reads `type` then the right
/// fields; we only ever use the mouse and keyboard members.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct INPUT {
    pub r#type: DWORD,
    pub u: INPUT_union,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union INPUT_union {
    pub mi: MOUSEINPUT,
    pub ki: KEYBDINPUT,
    // Padding to the size of the largest member on x64.
    pub pad: [u8; 32],
}

// Window-message broadcast (monitor power, etc.)
pub const WM_SYSCOMMAND: DWORD = 0x0112;
pub const SC_MONITORPOWER: WPARAM = 0xF170;
pub const HWND_BROADCAST: HWND = 0xffff as HWND;
pub const MONITOR_OFF: LPARAM = 2;

// ---------------------------------------------------------------------------
// Clipboard (user32 / kernel32)
// ---------------------------------------------------------------------------

pub const CF_UNICODETEXT: DWORD = 13;
pub const GMEM_MOVEABLE: DWORD = 0x0002;

// ---------------------------------------------------------------------------
// Token / elevation / shutdown privilege (advapi32)
// ---------------------------------------------------------------------------

pub const TOKEN_QUERY: DWORD = 0x0008;
pub const TOKEN_ADJUST_PRIVILEGES: DWORD = 0x0020;
pub const TokenElevation: i32 = 20;
pub const SE_PRIVILEGE_ENABLED: DWORD = 0x0002;

// ---------------------------------------------------------------------------
// Registry (advapi32) — read-only, for the firewall rule store
// ---------------------------------------------------------------------------

pub type HKEY = *mut c_void;
/// `(HKEY)(ULONG_PTR)(LONG)0x80000002` — sign-extended to pointer width.
pub const HKEY_LOCAL_MACHINE: HKEY = 0x8000_0002u32 as i32 as isize as HKEY;
pub const KEY_READ: DWORD = 0x0002_0019;
pub const REG_SZ: DWORD = 1;
pub const REG_EXPAND_SZ: DWORD = 2;
pub const ERROR_MORE_DATA: DWORD = 234;
pub const ERROR_NO_MORE_ITEMS: DWORD = 259;

// ---------------------------------------------------------------------------
// Elevated relaunch (shell32 ShellExecuteExW + kernel32 wait)
// ---------------------------------------------------------------------------

pub const SEE_MASK_NOCLOSEPROCESS: ULONG = 0x0000_0040;
pub const SEE_MASK_NOASYNC: ULONG = 0x0000_0100;
pub const SW_HIDE: i32 = 0;
pub const WAIT_OBJECT_0: DWORD = 0;
pub const ERROR_CANCELLED: DWORD = 1223;

/// `SHELLEXECUTEINFOW`. Natural alignment on Win64 (shellapi.h packs to 1 byte
/// only on 32-bit), 112 bytes on x64.
#[repr(C)]
pub struct SHELLEXECUTEINFOW {
    pub cbSize: DWORD,
    pub fMask: ULONG,
    pub hwnd: HWND,
    pub lpVerb: *const WCHAR,
    pub lpFile: *const WCHAR,
    pub lpParameters: *const WCHAR,
    pub lpDirectory: *const WCHAR,
    pub nShow: i32,
    pub hInstApp: HANDLE,
    pub lpIDList: *mut c_void,
    pub lpClass: *const WCHAR,
    pub hkeyClass: HKEY,
    pub dwHotKey: DWORD,
    /// Union of `hIcon` / `hMonitor`.
    pub hIconOrMonitor: HANDLE,
    pub hProcess: HANDLE,
}

pub const EWX_LOGOFF: DWORD = 0;
pub const EWX_SHUTDOWN: DWORD = 0x00000001;
pub const EWX_REBOOT: DWORD = 0x00000002;
pub const EWX_FORCE: DWORD = 0x00000004;
pub const EWX_POWEROFF: DWORD = 0x00000008;
pub const EWX_FORCEIFHUNG: DWORD = 0x00000010;
pub const SHTDN_REASON_FLAG_PLANNED: DWORD = 0x80000000;

#[repr(C)]
pub struct LUID {
    pub LowPart: DWORD,
    pub HighPart: LONG,
}

#[repr(C)]
pub struct LUID_AND_ATTRIBUTES {
    pub Luid: LUID,
    pub Attributes: DWORD,
}

#[repr(C)]
pub struct TOKEN_PRIVILEGES {
    pub PrivilegeCount: DWORD,
    pub Privileges: [LUID_AND_ATTRIBUTES; 1],
}

// ---------------------------------------------------------------------------
// Power status (kernel32)
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SYSTEM_POWER_STATUS {
    pub ACLineStatus: u8,
    pub BatteryFlag: u8,
    pub BatteryLifePercent: u8,
    pub SystemStatusFlag: u8,
    pub BatteryLifeTime: DWORD,
    pub BatteryFullLifeTime: DWORD,
}

// ---------------------------------------------------------------------------
// OS version (ntdll RtlGetVersion)
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct OSVERSIONINFOW {
    pub dwOSVersionInfoSize: DWORD,
    pub dwMajorVersion: DWORD,
    pub dwMinorVersion: DWORD,
    pub dwBuildNumber: DWORD,
    pub dwPlatformId: DWORD,
    pub szCSDVersion: [WCHAR; 128],
}

impl Default for OSVERSIONINFOW {
    fn default() -> Self {
        // `[u16; 128]` is larger than the arrays that derive `Default`, so the
        // zeroed value is spelled out here.
        OSVERSIONINFOW {
            dwOSVersionInfoSize: 0,
            dwMajorVersion: 0,
            dwMinorVersion: 0,
            dwBuildNumber: 0,
            dwPlatformId: 0,
            szCSDVersion: [0u16; 128],
        }
    }
}

pub const ComputerNamePhysicalDnsHostname: i32 = 5;

// ---------------------------------------------------------------------------
// Local time (kernel32 GetLocalTime)
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SYSTEMTIME {
    pub wYear: WORD,
    pub wMonth: WORD,
    pub wDayOfWeek: WORD,
    pub wDay: WORD,
    pub wHour: WORD,
    pub wMinute: WORD,
    pub wSecond: WORD,
    pub wMilliseconds: WORD,
}

// ---------------------------------------------------------------------------
// Adapter addresses (iphlpapi GetAdaptersAddresses)
// ---------------------------------------------------------------------------

pub const AF_UNSPEC: ULONG = 0;
pub const AF_INET: USHORT = 2;
pub const AF_INET6: USHORT = 23;

pub const GAA_FLAG_SKIP_ANYCAST: ULONG = 0x0002;
pub const GAA_FLAG_SKIP_MULTICAST: ULONG = 0x0004;
pub const GAA_FLAG_SKIP_DNS_SERVER: ULONG = 0x0008;

pub const ERROR_BUFFER_OVERFLOW: DWORD = 111;
pub const ERROR_SUCCESS: DWORD = 0;
pub const ERROR_ALREADY_EXISTS: DWORD = 183;

// IF_TYPE values (iftype.h)
pub const IF_TYPE_ETHERNET_CSMACD: DWORD = 6;
pub const IF_TYPE_IEEE80211: DWORD = 71; // Wi-Fi
pub const IF_TYPE_PPP: DWORD = 23;
pub const IF_TYPE_TUNNEL: DWORD = 131;
pub const IF_TYPE_SOFTWARE_LOOPBACK: DWORD = 24;

// IfOperStatus
pub const IfOperStatusUp: i32 = 1;

#[repr(C)]
pub struct SOCKADDR {
    pub sa_family: USHORT,
    pub sa_data: [u8; 14],
}

#[repr(C)]
pub struct SOCKET_ADDRESS {
    pub lpSockaddr: *mut SOCKADDR,
    pub iSockaddrLength: i32,
}

/// `IP_ADAPTER_UNICAST_ADDRESS_LH` — only the fields we read are named; the
/// leading union/length header is reproduced exactly so offsets line up.
#[repr(C)]
pub struct IP_ADAPTER_UNICAST_ADDRESS {
    pub Length: ULONG,
    pub Flags: DWORD,
    pub Next: *mut IP_ADAPTER_UNICAST_ADDRESS,
    pub Address: SOCKET_ADDRESS,
    pub PrefixOrigin: i32,
    pub SuffixOrigin: i32,
    pub DadState: i32,
    pub ValidLifetime: ULONG,
    pub PreferredLifetime: ULONG,
    pub LeaseLifetime: ULONG,
    pub OnLinkPrefixLength: u8,
}

/// `IP_ADAPTER_ADDRESSES_LH`. We read the name, the unicast list, the
/// interface type and the operational status; later fields are padded over
/// with raw bytes so the struct size matches without naming every member.
#[repr(C)]
pub struct IP_ADAPTER_ADDRESSES {
    pub Length: ULONG,
    pub IfIndex: DWORD,
    pub Next: *mut IP_ADAPTER_ADDRESSES,
    pub AdapterName: *mut u8, // char*
    pub FirstUnicastAddress: *mut IP_ADAPTER_UNICAST_ADDRESS,
    pub FirstAnycastAddress: *mut c_void,
    pub FirstMulticastAddress: *mut c_void,
    pub FirstDnsServerAddress: *mut c_void,
    pub DnsSuffix: *mut WCHAR,
    pub Description: *mut WCHAR,
    pub FriendlyName: *mut WCHAR,
    pub PhysicalAddress: [u8; 8],
    pub PhysicalAddressLength: ULONG,
    pub Flags: DWORD,
    pub Mtu: DWORD,
    pub IfType: DWORD,
    pub OperStatus: i32,
    // Remaining fields of the structure are not read; reserve space so the
    // allocation GetAdaptersAddresses walks stays correctly sized. The LH
    // layout has a number of further pointers/longs; 200 bytes is a safe
    // over-allocation and we never index past OperStatus.
    pub _tail: [u8; 200],
}

// ---------------------------------------------------------------------------
// extern blocks
// ---------------------------------------------------------------------------

#[link(name = "kernel32")]
extern "system" {
    pub fn GetStdHandle(nStdHandle: DWORD) -> HANDLE;
    pub fn GetConsoleMode(hConsoleHandle: HANDLE, lpMode: *mut DWORD) -> BOOL;
    pub fn SetConsoleMode(hConsoleHandle: HANDLE, dwMode: DWORD) -> BOOL;
    pub fn SetConsoleOutputCP(wCodePageID: DWORD) -> BOOL;
    pub fn SetConsoleTitleW(lpConsoleTitle: *const WCHAR) -> BOOL;
    pub fn GetCurrentProcess() -> HANDLE;
    pub fn GetSystemPowerStatus(lpSystemPowerStatus: *mut SYSTEM_POWER_STATUS) -> BOOL;
    pub fn GetComputerNameExW(NameType: i32, lpBuffer: *mut WCHAR, nSize: *mut DWORD) -> BOOL;
    pub fn GetTickCount64() -> u64;
    pub fn GetLocalTime(lpSystemTime: *mut SYSTEMTIME);
    pub fn GlobalAlloc(uFlags: DWORD, dwBytes: usize) -> HGLOBAL;
    pub fn GlobalLock(hMem: HGLOBAL) -> *mut c_void;
    pub fn GlobalUnlock(hMem: HGLOBAL) -> BOOL;
    pub fn GlobalFree(hMem: HGLOBAL) -> HGLOBAL;
    pub fn GlobalSize(hMem: HGLOBAL) -> usize;
    pub fn CreateMutexW(
        lpMutexAttributes: *mut c_void,
        bInitialOwner: BOOL,
        lpName: *const WCHAR,
    ) -> HANDLE;
    pub fn GetLastError() -> DWORD;
    pub fn CloseHandle(hObject: HANDLE) -> BOOL;
    pub fn LoadLibraryW(lpLibFileName: *const WCHAR) -> HANDLE;
    pub fn GetProcAddress(hModule: HANDLE, lpProcName: *const u8) -> *mut c_void;
    pub fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) -> DWORD;
    pub fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *mut DWORD) -> BOOL;
}

#[link(name = "user32")]
extern "system" {
    pub fn SendInput(cInputs: DWORD, pInputs: *const INPUT, cbSize: i32) -> DWORD;
    pub fn GetCursorPos(lpPoint: *mut POINT) -> BOOL;
    pub fn SetCursorPos(x: i32, y: i32) -> BOOL;
    pub fn GetSystemMetrics(nIndex: i32) -> i32;
    pub fn MapVirtualKeyW(uCode: DWORD, uMapType: DWORD) -> DWORD;
    pub fn SendMessageW(hWnd: HWND, Msg: DWORD, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    pub fn OpenClipboard(hWndNewOwner: HWND) -> BOOL;
    pub fn EmptyClipboard() -> BOOL;
    pub fn CloseClipboard() -> BOOL;
    pub fn SetClipboardData(uFormat: DWORD, hMem: HANDLE) -> HANDLE;
    pub fn GetClipboardData(uFormat: DWORD) -> HANDLE;
    pub fn IsClipboardFormatAvailable(format: DWORD) -> BOOL;
    pub fn LockWorkStation() -> BOOL;
    pub fn ExitWindowsEx(uFlags: DWORD, dwReason: DWORD) -> BOOL;
    pub fn SetProcessDpiAwarenessContext(value: HANDLE) -> BOOL;
}

/// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` is the opaque handle value -4.
/// Making the process per-monitor-v2 aware keeps `GetCursorPos`/`SetCursorPos`
/// in true pixels under display scaling, so absolute mouse moves land correctly.
pub const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: HANDLE = -4isize as HANDLE;

#[link(name = "advapi32")]
extern "system" {
    pub fn OpenProcessToken(
        ProcessHandle: HANDLE,
        DesiredAccess: DWORD,
        TokenHandle: *mut HANDLE,
    ) -> BOOL;
    pub fn GetTokenInformation(
        TokenHandle: HANDLE,
        TokenInformationClass: i32,
        TokenInformation: *mut c_void,
        TokenInformationLength: DWORD,
        ReturnLength: *mut DWORD,
    ) -> BOOL;
    pub fn LookupPrivilegeValueW(
        lpSystemName: *const WCHAR,
        lpName: *const WCHAR,
        lpLuid: *mut LUID,
    ) -> BOOL;
    pub fn AdjustTokenPrivileges(
        TokenHandle: HANDLE,
        DisableAllPrivileges: BOOL,
        NewState: *const TOKEN_PRIVILEGES,
        BufferLength: DWORD,
        PreviousState: *mut TOKEN_PRIVILEGES,
        ReturnLength: *mut DWORD,
    ) -> BOOL;
    pub fn RegOpenKeyExW(
        hKey: HKEY,
        lpSubKey: *const WCHAR,
        ulOptions: DWORD,
        samDesired: DWORD,
        phkResult: *mut HKEY,
    ) -> LONG;
    pub fn RegQueryInfoKeyW(
        hKey: HKEY,
        lpClass: *mut WCHAR,
        lpcchClass: *mut DWORD,
        lpReserved: *mut DWORD,
        lpcSubKeys: *mut DWORD,
        lpcbMaxSubKeyLen: *mut DWORD,
        lpcbMaxClassLen: *mut DWORD,
        lpcValues: *mut DWORD,
        lpcbMaxValueNameLen: *mut DWORD,
        lpcbMaxValueLen: *mut DWORD,
        lpcbSecurityDescriptor: *mut DWORD,
        lpftLastWriteTime: *mut c_void,
    ) -> LONG;
    pub fn RegEnumValueW(
        hKey: HKEY,
        dwIndex: DWORD,
        lpValueName: *mut WCHAR,
        lpcchValueName: *mut DWORD,
        lpReserved: *mut DWORD,
        lpType: *mut DWORD,
        lpData: *mut u8,
        lpcbData: *mut DWORD,
    ) -> LONG;
    pub fn RegCloseKey(hKey: HKEY) -> LONG;
}

#[link(name = "shell32")]
extern "system" {
    pub fn ShellExecuteW(
        hwnd: HWND,
        lpOperation: *const WCHAR,
        lpFile: *const WCHAR,
        lpParameters: *const WCHAR,
        lpDirectory: *const WCHAR,
        nShowCmd: i32,
    ) -> HANDLE;
    pub fn ShellExecuteExW(pExecInfo: *mut SHELLEXECUTEINFOW) -> BOOL;
}

#[link(name = "iphlpapi")]
extern "system" {
    pub fn GetAdaptersAddresses(
        Family: ULONG,
        Flags: ULONG,
        Reserved: *mut c_void,
        AdapterAddresses: *mut IP_ADAPTER_ADDRESSES,
        SizePointer: *mut ULONG,
    ) -> ULONG;
}

#[link(name = "bcrypt")]
extern "system" {
    pub fn BCryptGenRandom(
        hAlgorithm: *mut c_void,
        pbBuffer: *mut u8,
        cbBuffer: ULONG,
        dwFlags: ULONG,
    ) -> NTSTATUS;
}

pub const BCRYPT_USE_SYSTEM_PREFERRED_RNG: ULONG = 0x00000002;

#[link(name = "ntdll")]
extern "system" {
    pub fn RtlGetVersion(lpVersionInformation: *mut OSVERSIONINFOW) -> NTSTATUS;
}

// `SetSuspendState` lives in powrprof.dll, whose import library the mingw
// sysroot does not ship. Rather than depend on it at link time, it is resolved
// at runtime (see `win::power::suspend`) through this function-pointer type.
pub type SetSuspendStateFn =
    unsafe extern "system" fn(bHibernate: BOOL, bForce: BOOL, bWakeupEventsDisabled: BOOL) -> BOOL;
