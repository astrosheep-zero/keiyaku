#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
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

static HANDLE output_handle(void) {
  return GetStdHandle(STD_OUTPUT_HANDLE);
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

static void write_output(const char *value) {
  HANDLE handle = output_handle();
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

static LPPROC_THREAD_ATTRIBUTE_LIST create_handle_list(HANDLE *handles, SIZE_T count) {
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  if (size == 0) fail_message("spawn launcher EINVAL");
  LPPROC_THREAD_ATTRIBUTE_LIST list =
    (LPPROC_THREAD_ATTRIBUTE_LIST)heap_alloc(size);
  if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) {
    HeapFree(GetProcessHeap(), 0, list);
    fail_message("spawn launcher EINVAL");
  }
  if (!UpdateProcThreadAttribute(
        list,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles,
        count * sizeof(HANDLE),
        NULL,
        NULL
      )) {
    DeleteProcThreadAttributeList(list);
    HeapFree(GetProcessHeap(), 0, list);
    fail_message("spawn launcher EINVAL");
  }
  return list;
}

struct RetainedControl {
  HANDLE release_event;
};

static int read_command(char *command, SIZE_T capacity) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  SIZE_T length = 0;
  if (input == NULL || input == INVALID_HANDLE_VALUE || capacity < 2) return 0;
  for (;;) {
    char value;
    DWORD read = 0;
    if (!ReadFile(input, &value, 1, &read, NULL) || read == 0) return 0;
    if (value == '\n') {
      command[length] = '\0';
      return 1;
    }
    if (value != '\r' && length + 1 < capacity) command[length++] = value;
  }
}

static DWORD WINAPI retained_control(void *argument) {
  struct RetainedControl *control = (struct RetainedControl *)argument;
  char command[32];
  if (!read_command(command, sizeof(command))) {
    SetEvent(control->release_event);
    return 0;
  }
  if (lstrcmpA(command, "release") == 0) {
    SetEvent(control->release_event);
    return 0;
  }
  SetEvent(control->release_event);
  return 0;
}

static void write_started(DWORD pid) {
  char line[64];
  SIZE_T length = 0;
  const char *prefix = "started ";
  while (prefix[length] != '\0') { line[length] = prefix[length]; length += 1; }
  char digits[16];
  SIZE_T count = 0;
  do { digits[count++] = (char)('0' + (pid % 10)); pid /= 10; } while (pid != 0);
  while (count > 0) line[length++] = digits[--count];
  line[length++] = '\n';
  line[length] = '\0';
  write_output(line);
}

static void write_exited(DWORD code) {
  char line[64];
  SIZE_T length = 0;
  const char *prefix = "exited ";
  while (prefix[length] != '\0') { line[length] = prefix[length]; length += 1; }
  char digits[16];
  SIZE_T count = 0;
  do { digits[count++] = (char)('0' + (code % 10)); code /= 10; } while (code != 0);
  while (count > 0) line[length++] = digits[--count];
  line[length++] = '\n';
  line[length] = '\0';
  write_output(line);
}

static int launch(const wchar_t *log_path, int argc, wchar_t **argv) {
  if (argc < 1 || argv[0][0] == L'\0') fail_message("spawn launcher EINVAL");

  HANDLE log = open_log(log_path);
  HANDLE nul = open_nul();
  struct CommandLine command = build_command_line(argc, argv);
  STARTUPINFOEXW startup = { 0 };
  PROCESS_INFORMATION process = { 0 };
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = nul;
  startup.StartupInfo.hStdOutput = log;
  startup.StartupInfo.hStdError = log;

  // The target receives only its explicit log/NUL handles. The launcher's
  // protocol and diagnostic pipes stay private to the retained owner.
  HANDLE inheritedHandles[] = { nul, log };
  startup.lpAttributeList = create_handle_list(
    inheritedHandles,
    sizeof(inheritedHandles) / sizeof(inheritedHandles[0])
  );
  HANDLE launcherHandles[] = {
    GetStdHandle(STD_INPUT_HANDLE),
    GetStdHandle(STD_OUTPUT_HANDLE),
    GetStdHandle(STD_ERROR_HANDLE),
  };
  for (SIZE_T index = 0; index < sizeof(launcherHandles) / sizeof(launcherHandles[0]); index += 1) {
    HANDLE handle = launcherHandles[index];
    if (handle != NULL && handle != INVALID_HANDLE_VALUE) {
      SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
    }
  }

  BOOL created = CreateProcessW(
    NULL,
    command.value,
    NULL,
    NULL,
    TRUE,
    CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
    NULL,
    NULL,
    &startup.StartupInfo,
    &process
  );
  if (!created) {
    DWORD error = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
    CloseHandle(log);
    CloseHandle(nul);
    HeapFree(GetProcessHeap(), 0, command.value);
    fail_spawn(argv[0], spawn_code(error));
  }

  write_started(process.dwProcessId);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  CloseHandle(process.hThread);
  CloseHandle(log);
  CloseHandle(nul);
  HeapFree(GetProcessHeap(), 0, command.value);

  HANDLE release_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (release_event == NULL) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hProcess);
    fail_message("spawn launcher EINVAL");
  }
  struct RetainedControl control = { release_event };
  HANDLE control_thread = CreateThread(NULL, 0, retained_control, &control, 0, NULL);
  if (control_thread == NULL) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(release_event);
    CloseHandle(process.hProcess);
    fail_message("spawn launcher EINVAL");
  }
  HANDLE waits[2] = { process.hProcess, release_event };
  DWORD winner = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  if (winner == WAIT_OBJECT_0 + 1) {
    WaitForSingleObject(control_thread, INFINITE);
    CloseHandle(control_thread);
    CloseHandle(release_event);
    CloseHandle(process.hProcess);
    return 0;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  write_exited(code);
  CancelSynchronousIo(control_thread);
  WaitForSingleObject(control_thread, INFINITE);
  CloseHandle(control_thread);
  CloseHandle(release_event);
  CloseHandle(process.hProcess);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 4) fail_message("spawn launcher EINVAL");
  if (lstrcmpW(argv[1], L"--retain") != 0) fail_message("spawn launcher EINVAL");
  return launch(argv[2], argc - 3, argv + 3);
}
