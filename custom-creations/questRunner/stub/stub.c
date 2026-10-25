// Idle process with an offscreen window so Discord's game detector picks it up.
// QR_TITLE sets the window title, QR_PARENT is a PID to outlive (Discord's main process).
#include <windows.h>

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    if (msg == WM_DESTROY) {
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static DWORD ParseDword(const WCHAR *s)
{
    DWORD v = 0;
    while (*s >= L'0' && *s <= L'9')
        v = v * 10 + (DWORD)(*s++ - L'0');
    return v;
}

void WinMainCRTStartup(void)
{
    // Static so the no-CRT build doesn't need memset for zero-initialization.
    static WCHAR title[256];
    static WCHAR parentText[16];
    static WNDCLASSW wc;
    HINSTANCE inst = GetModuleHandleW(NULL);
    HANDLE parent = NULL;
    HWND hwnd;
    MSG msg;

    DWORD titleLength = GetEnvironmentVariableW(L"QR_TITLE", title, 256);
    if (titleLength == 0 || titleLength >= 256)
        lstrcpyW(title, L"Game");
    DWORD parentLength = GetEnvironmentVariableW(L"QR_PARENT", parentText, 16);
    if (parentLength > 0 && parentLength < 16)
        parent = OpenProcess(SYNCHRONIZE, FALSE, ParseDword(parentText));
    // Without a parent to watch, the stand-in could outlive Discord, so it doesn't start at all.
    if (!parent)
        ExitProcess(3);

    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.lpszClassName = L"UnityWndClass";
    if (!RegisterClassW(&wc))
        ExitProcess(1);

    hwnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, wc.lpszClassName, title,
                           WS_POPUP, -32000, -32000, 1, 1, NULL, NULL, inst, NULL);
    if (!hwnd)
        ExitProcess(2);
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);

    for (;;) {
        DWORD r = MsgWaitForMultipleObjects(1, &parent, FALSE, INFINITE, QS_ALLINPUT);
        if (r == WAIT_OBJECT_0)
            ExitProcess(0);
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT)
                ExitProcess(0);
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
