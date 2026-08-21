#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* cl /O2 /MT /DUNICODE /D_UNICODE /Fewindows-launch.exe windows-launch.c /link /SUBSYSTEM:WINDOWS /MACHINE:X64 */

struct CommandLine {
  wchar_t *value;
  SIZE_T length;
  SIZE_T capacity;
};

static HANDLE error_handle(void) {
  return GetStdHandle(STD_ERROR_HANDLE);
}

static SIZE_T narrow_length(const char *value) {
  SIZE_T length = 0;
  while (value[length] != '\0') length += 1;
  return length;
}

static void write_error(const char *value) {
  HANDLE handle = error_handle();
  if (handle == NULL || handle == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(handle, value, (DWORD)narrow_length(value), &written, NULL);
}

static void fail_message(const char *message) {
  write_error(message);
  write_error("\n");
  ExitProcess(1);
}

static void fail_spawn(const wchar_t *executable, const char *code) {
  char converted[1024];
  int length = WideCharToMultiByte(CP_UTF8, 0, executable, -1, converted, (int)sizeof(converted), NULL, NULL);
  write_error("spawn ");
  if (length > 1) {
    HANDLE handle = error_handle();
    DWORD written = 0;
    WriteFile(handle, converted, (DWORD)(length - 1), &written, NULL);
  }
  write_error(" ");
  write_error(code);
  write_error("\n");
  ExitProcess(1);
}

static void *heap_alloc(SIZE_T size) {
  void *value = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
  if (value == NULL) fail_message("spawn launcher ENOMEM");
  return value;
}

static void *heap_realloc(void *value, SIZE_T size) {
  void *result = value == NULL
    ? HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size)
    : HeapReAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, value, size);
  if (result == NULL) fail_message("spawn launcher ENOMEM");
  return result;
}

static void append_character(struct CommandLine *line, wchar_t value) {
  if (line->length + 1 >= line->capacity) {
    line->capacity = line->capacity == 0 ? 256 : line->capacity * 2;
    line->value = (wchar_t *)heap_realloc(line->value, line->capacity * sizeof(wchar_t));
  }
  line->value[line->length++] = value;
  line->value[line->length] = L'\0';
}

static void append_repeated(struct CommandLine *line, wchar_t value, SIZE_T count) {
  for (SIZE_T index = 0; index < count; index += 1) append_character(line, value);
}

static int needs_quotes(const wchar_t *value) {
  if (value[0] == L'\0') return 1;
  for (const wchar_t *cursor = value; *cursor != L'\0'; cursor += 1) {
    if (*cursor == L' ' || *cursor == L'\t' || *cursor == L'"') return 1;
  }
  return 0;
}

static void append_argument(struct CommandLine *line, const wchar_t *value) {
  if (line->length > 0) append_character(line, L' ');
  if (!needs_quotes(value)) {
    for (const wchar_t *cursor = value; *cursor != L'\0'; cursor += 1) append_character(line, *cursor);
    return;
  }

  append_character(line, L'"');
  SIZE_T backslashes = 0;
  for (const wchar_t *cursor = value; *cursor != L'\0'; cursor += 1) {
    if (*cursor == L'\\') {
      backslashes += 1;
      continue;
    }
    if (*cursor == L'"') {
      append_repeated(line, L'\\', backslashes * 2 + 1);
      append_character(line, L'"');
    } else {
      append_repeated(line, L'\\', backslashes);
      append_character(line, *cursor);
    }
    backslashes = 0;
  }
  append_repeated(line, L'\\', backslashes * 2);
  append_character(line, L'"');
}

static struct CommandLine build_command_line(int argc, wchar_t **argv) {
  struct CommandLine line = { 0 };
  for (int index = 0; index < argc; index += 1) append_argument(&line, argv[index]);
  if (line.value == NULL) fail_message("spawn launcher EINVAL");
  return line;
}

static const char *spawn_code(DWORD error) {
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_INVALID_DRIVE) return "ENOENT";
  if (error == ERROR_ACCESS_DENIED) return "EACCES";
  if (error == ERROR_INVALID_PARAMETER || error == ERROR_NOACCESS) return "EINVAL";
  return "UNKNOWN";
}

static HANDLE open_log(const wchar_t *path) {
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  HANDLE handle = CreateFileW(
    path,
    FILE_APPEND_DATA | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (handle == INVALID_HANDLE_VALUE) fail_spawn(path, spawn_code(GetLastError()));
  return handle;
}

static HANDLE open_nul(void) {
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  HANDLE handle = CreateFileW(
    L"NUL",
    GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (handle == INVALID_HANDLE_VALUE) fail_message("spawn launcher ENOENT");
  return handle;
}

static int launch(const wchar_t *log_path, int argc, wchar_t **argv) {
  if (argc < 1 || argv[0][0] == L'\0') fail_message("spawn launcher EINVAL");

  HANDLE log = open_log(log_path);
  HANDLE nul = open_nul();
  struct CommandLine command = build_command_line(argc, argv);
  STARTUPINFOW startup = { 0 };
  PROCESS_INFORMATION process = { 0 };
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = nul;
  startup.hStdOutput = log;
  startup.hStdError = log;

  // Clear HANDLE_FLAG_INHERIT on the launcher's diagnostic stderr pipe
  // while leaving intended log/NUL handles inheritable.
  HANDLE stderrHandle = GetStdHandle(STD_ERROR_HANDLE);
  if (stderrHandle != INVALID_HANDLE_VALUE) {
    SetHandleInformation(stderrHandle, HANDLE_FLAG_INHERIT, 0);
  }

  BOOL created = CreateProcessW(
    NULL,
    command.value,
    NULL,
    NULL,
    TRUE,
    CREATE_NO_WINDOW,
    NULL,
    NULL,
    &startup,
    &process
  );
  if (!created) {
    DWORD error = GetLastError();
    CloseHandle(log);
    CloseHandle(nul);
    fail_spawn(argv[0], spawn_code(error));
  }

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(log);
  CloseHandle(nul);
  HeapFree(GetProcessHeap(), 0, command.value);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 3) fail_message("spawn launcher EINVAL");
  return launch(argv[1], argc - 2, argv + 2);
}
