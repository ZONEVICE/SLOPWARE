/*
 * A stand-in bcryptprimitives.dll for running tendril.exe under Wine 6.
 *
 * Rust's standard library gets randomness on Windows from
 * bcryptprimitives.dll!ProcessPrng (Windows 10+), which Wine 6 lacks, so
 * tendril.exe would not start there. This DLL exports ProcessPrng on top of
 * advapi32!SystemFunction036 (RtlGenRandom), which Wine has. It is a test
 * aid only: real Windows 10/11 has ProcessPrng and never needs this file.
 *
 * Built by run.sh with:
 *   zig cc -shared -target x86_64-windows-gnu -o bcryptprimitives.dll processprng.c -ladvapi32
 */
#include <windows.h>

BOOLEAN NTAPI SystemFunction036(PVOID buffer, ULONG length);

__declspec(dllexport) BOOL WINAPI ProcessPrng(PBYTE data, SIZE_T length) {
    while (length > 0) {
        ULONG chunk = length > 0x10000000 ? 0x10000000 : (ULONG)length;
        if (!SystemFunction036(data, chunk)) {
            return FALSE;
        }
        data += chunk;
        length -= chunk;
    }
    return TRUE;
}
