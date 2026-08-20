#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* zig cc -target x86_64-windows-gnu -mwindows -O2 -s -o windows-launch.exe windows-launch.c */

enum { JSON_MAX = 16 * 1024 * 1024 };

struct Json {
  const char *cursor;
  const char *end;
};

struct WString {
  wchar_t *data;
  int length;
};

struct WList {
  struct WString *items;
  int count;
  int capacity;
};

struct EnvPair {
  struct WString key;
  struct WString value;
};

struct EnvList {
  struct EnvPair *items;
  int count;
  int capacity;
};

static HANDLE stderr_handle(void) {
  return GetStdHandle(STD_ERROR_HANDLE);
}

static void write_stderr(const char *text, DWORD length) {
  HANDLE handle = stderr_handle();
  if (handle == NULL || handle == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(handle, text, length, &written, NULL);
}

static DWORD c_length(const char *text) {
  DWORD length = 0;
  while (text[length] != 0) length += 1;
  return length;
}

static void fail_message(const char *message) {
  write_stderr(message, c_length(message));
  write_stderr("\n", 1);
  ExitProcess(1);
}

static void fail_spawn(const wchar_t *exe, const char *code) {
  char utf8[1024];
  int converted = WideCharToMultiByte(CP_UTF8, 0, exe == NULL ? L"" : exe, -1, utf8, (int)sizeof(utf8), NULL, NULL);
  write_stderr("spawn ", 6);
  if (converted > 1) write_stderr(utf8, (DWORD)(converted - 1));
  write_stderr(" ", 1);
  write_stderr(code, c_length(code));
  write_stderr("\n", 1);
  ExitProcess(1);
}

static void *heap_alloc(SIZE_T size) {
  void *memory = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
  if (memory == NULL) fail_message("spawn launcher ENOMEM");
  return memory;
}

static void *heap_realloc(void *memory, SIZE_T size) {
  void *resized = memory == NULL
    ? HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size)
    : HeapReAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, memory, size);
  if (resized == NULL) fail_message("spawn launcher ENOMEM");
  return resized;
}

static int is_space(char value) {
  return value == ' ' || value == '\t' || value == '\n' || value == '\r';
}

static char peek(struct Json *json) {
  return json->cursor < json->end ? *json->cursor : 0;
}

static char next(struct Json *json) {
  if (json->cursor >= json->end) fail_message("spawn launcher EINVAL");
  char value = *json->cursor;
  json->cursor += 1;
  return value;
}

static void skip_space(struct Json *json) {
  while (is_space(peek(json))) json->cursor += 1;
}

static void expect(struct Json *json, char value) {
  skip_space(json);
  if (next(json) != value) fail_message("spawn launcher EINVAL");
}

static int hex_value(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  fail_message("spawn launcher EINVAL");
  return 0;
}

static void append_byte(char **buffer, int *length, int *capacity, char value) {
  if (*length + 1 >= *capacity) {
    *capacity = *capacity == 0 ? 64 : *capacity * 2;
    *buffer = (char *)heap_realloc(*buffer, (SIZE_T)(*capacity));
  }
  (*buffer)[*length] = value;
  *length += 1;
}

static void append_utf8(char **buffer, int *length, int *capacity, unsigned codepoint) {
  if (codepoint <= 0x7F) {
    append_byte(buffer, length, capacity, (char)codepoint);
    return;
  }
  if (codepoint <= 0x7FF) {
    append_byte(buffer, length, capacity, (char)(0xC0 | (codepoint >> 6)));
    append_byte(buffer, length, capacity, (char)(0x80 | (codepoint & 0x3F)));
    return;
  }
  if (codepoint <= 0xFFFF) {
    append_byte(buffer, length, capacity, (char)(0xE0 | (codepoint >> 12)));
    append_byte(buffer, length, capacity, (char)(0x80 | ((codepoint >> 6) & 0x3F)));
    append_byte(buffer, length, capacity, (char)(0x80 | (codepoint & 0x3F)));
    return;
  }
  append_byte(buffer, length, capacity, (char)(0xF0 | (codepoint >> 18)));
  append_byte(buffer, length, capacity, (char)(0x80 | ((codepoint >> 12) & 0x3F)));
  append_byte(buffer, length, capacity, (char)(0x80 | ((codepoint >> 6) & 0x3F)));
  append_byte(buffer, length, capacity, (char)(0x80 | (codepoint & 0x3F)));
}

static struct WString utf8_to_wide(const char *utf8, int length) {
  struct WString result = { 0 };
  if (length == 0) {
    result.data = (wchar_t *)heap_alloc(sizeof(wchar_t));
    return result;
  }
  int wide_length = MultiByteToWideChar(CP_UTF8, 0, utf8, length, NULL, 0);
  if (wide_length <= 0) fail_message("spawn launcher EINVAL");
  result.data = (wchar_t *)heap_alloc((SIZE_T)(wide_length + 1) * sizeof(wchar_t));
  if (MultiByteToWideChar(CP_UTF8, 0, utf8, length, result.data, wide_length) != wide_length) {
    fail_message("spawn launcher EINVAL");
  }
  result.length = wide_length;
  return result;
}

static struct WString parse_string(struct Json *json) {
  skip_space(json);
  if (next(json) != '"') fail_message("spawn launcher EINVAL");
  char *utf8 = NULL;
  int length = 0;
  int capacity = 0;
  for (;;) {
    char value = next(json);
    if (value == '"') break;
    if ((unsigned char)value < 0x20) fail_message("spawn launcher EINVAL");
    if (value != '\\') {
      append_byte(&utf8, &length, &capacity, value);
      continue;
    }
    char escaped = next(json);
    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        append_byte(&utf8, &length, &capacity, escaped);
        break;
      case 'b': append_byte(&utf8, &length, &capacity, '\b'); break;
      case 'f': append_byte(&utf8, &length, &capacity, '\f'); break;
      case 'n': append_byte(&utf8, &length, &capacity, '\n'); break;
      case 'r': append_byte(&utf8, &length, &capacity, '\r'); break;
      case 't': append_byte(&utf8, &length, &capacity, '\t'); break;
      case 'u': {
        unsigned codepoint = 0;
        for (int index = 0; index < 4; index += 1) codepoint = (codepoint << 4) | (unsigned)hex_value(next(json));
        if (codepoint >= 0xD800 && codepoint <= 0xDBFF && peek(json) == '\\') {
          next(json);
          if (next(json) != 'u') fail_message("spawn launcher EINVAL");
          unsigned low = 0;
          for (int index = 0; index < 4; index += 1) low = (low << 4) | (unsigned)hex_value(next(json));
          if (low < 0xDC00 || low > 0xDFFF) fail_message("spawn launcher EINVAL");
          codepoint = 0x10000 + (((codepoint - 0xD800) << 10) | (low - 0xDC00));
        }
        append_utf8(&utf8, &length, &capacity, codepoint);
        break;
      }
      default:
        fail_message("spawn launcher EINVAL");
    }
  }
  struct WString result = utf8_to_wide(utf8 == NULL ? "" : utf8, length);
  if (utf8 != NULL) HeapFree(GetProcessHeap(), 0, utf8);
  return result;
}

static int string_equals(struct WString value, const wchar_t *expected) {
  int index = 0;
  while (expected[index] != 0) {
    if (index >= value.length || value.data[index] != expected[index]) return 0;
    index += 1;
  }
  return index == value.length;
}

static void list_push(struct WList *list, struct WString value) {
  if (list->count == list->capacity) {
    list->capacity = list->capacity == 0 ? 4 : list->capacity * 2;
    list->items = (struct WString *)heap_realloc(list->items, (SIZE_T)list->capacity * sizeof(*list->items));
  }
  list->items[list->count] = value;
  list->count += 1;
}

static void env_push(struct EnvList *list, struct EnvPair value) {
  if (list->count == list->capacity) {
    list->capacity = list->capacity == 0 ? 8 : list->capacity * 2;
    list->items = (struct EnvPair *)heap_realloc(list->items, (SIZE_T)list->capacity * sizeof(*list->items));
  }
  list->items[list->count] = value;
  list->count += 1;
}

static struct WList parse_argv(struct Json *json) {
  struct WList list = { 0 };
  expect(json, '[');
  skip_space(json);
  if (peek(json) == ']') {
    next(json);
    return list;
  }
  for (;;) {
    list_push(&list, parse_string(json));
    skip_space(json);
    char value = next(json);
    if (value == ']') return list;
    if (value != ',') fail_message("spawn launcher EINVAL");
  }
}

static struct EnvList parse_env(struct Json *json) {
  struct EnvList list = { 0 };
  expect(json, '{');
  skip_space(json);
  if (peek(json) == '}') {
    next(json);
    return list;
  }
  for (;;) {
    struct EnvPair pair;
    pair.key = parse_string(json);
    expect(json, ':');
    pair.value = parse_string(json);
    env_push(&list, pair);
    skip_space(json);
    char value = next(json);
    if (value == '}') return list;
    if (value != ',') fail_message("spawn launcher EINVAL");
  }
}

static int needs_quotes(const wchar_t *value) {
  if (value[0] == 0) return 1;
  for (const wchar_t *cursor = value; *cursor != 0; cursor += 1) {
    if (*cursor == L' ' || *cursor == L'\t' || *cursor == L'"') return 1;
  }
  return 0;
}

static void append_wide(wchar_t **buffer, int *length, int *capacity, const wchar_t *value, int count) {
  if (*length + count + 1 > *capacity) {
    int next_capacity = *capacity == 0 ? 256 : *capacity;
    while (next_capacity < *length + count + 1) next_capacity *= 2;
    *buffer = (wchar_t *)heap_realloc(*buffer, (SIZE_T)next_capacity * sizeof(wchar_t));
    *capacity = next_capacity;
  }
  for (int index = 0; index < count; index += 1) {
    (*buffer)[*length] = value[index];
    *length += 1;
  }
  (*buffer)[*length] = 0;
}

static void append_quoted(wchar_t **buffer, int *length, int *capacity, const wchar_t *value) {
  if (!needs_quotes(value)) {
    int count = 0;
    while (value[count] != 0) count += 1;
    if (*length > 0) append_wide(buffer, length, capacity, L" ", 1);
    append_wide(buffer, length, capacity, value, count);
    return;
  }
  if (*length > 0) append_wide(buffer, length, capacity, L" ", 1);
  append_wide(buffer, length, capacity, L"\"", 1);
  int slashes = 0;
  for (const wchar_t *cursor = value; *cursor != 0; cursor += 1) {
    if (*cursor == L'\\') {
      slashes += 1;
      continue;
    }
    if (*cursor == L'"') {
      for (int index = 0; index < slashes * 2 + 1; index += 1) append_wide(buffer, length, capacity, L"\\", 1);
      append_wide(buffer, length, capacity, L"\"", 1);
      slashes = 0;
      continue;
    }
    for (int index = 0; index < slashes; index += 1) append_wide(buffer, length, capacity, L"\\", 1);
    append_wide(buffer, length, capacity, cursor, 1);
    slashes = 0;
  }
  for (int index = 0; index < slashes * 2; index += 1) append_wide(buffer, length, capacity, L"\\", 1);
  append_wide(buffer, length, capacity, L"\"", 1);
}

static wchar_t *build_command_line(struct WList *argv) {
  wchar_t *buffer = NULL;
  int length = 0;
  int capacity = 0;
  for (int index = 0; index < argv->count; index += 1) append_quoted(&buffer, &length, &capacity, argv->items[index].data);
  if (buffer == NULL) fail_spawn(NULL, "EINVAL");
  return buffer;
}

static wchar_t *build_env_block(struct EnvList *env) {
  int size = 1;
  for (int index = 0; index < env->count; index += 1) {
    size += env->items[index].key.length + 1 + env->items[index].value.length + 1;
  }
  wchar_t *block = (wchar_t *)heap_alloc((SIZE_T)(size + 1) * sizeof(wchar_t));
  int cursor = 0;
  for (int index = 0; index < env->count; index += 1) {
    struct EnvPair *pair = &env->items[index];
    for (int offset = 0; offset < pair->key.length; offset += 1) block[cursor++] = pair->key.data[offset];
    block[cursor++] = L'=';
    for (int offset = 0; offset < pair->value.length; offset += 1) block[cursor++] = pair->value.data[offset];
    block[cursor++] = 0;
  }
  block[cursor] = 0;
  return block;
}

static const char *spawn_code(DWORD error) {
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_INVALID_DRIVE) return "ENOENT";
  if (error == ERROR_ACCESS_DENIED) return "EACCES";
  if (error == ERROR_NOACCESS || error == ERROR_INVALID_PARAMETER) return "EINVAL";
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
    0,
    NULL
  );
  if (handle == INVALID_HANDLE_VALUE) fail_message("spawn launcher ENOENT");
  return handle;
}

static char *read_stdin(int *length) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == NULL || input == INVALID_HANDLE_VALUE) fail_message("spawn launcher EINVAL");
  int capacity = 4096;
  int size = 0;
  char *buffer = (char *)heap_alloc((SIZE_T)capacity);
  for (;;) {
    if (size == capacity) {
      if (capacity >= JSON_MAX) fail_message("spawn launcher ENOMEM");
      capacity *= 2;
      buffer = (char *)heap_realloc(buffer, (SIZE_T)capacity);
    }
    DWORD read = 0;
    if (!ReadFile(input, buffer + size, (DWORD)(capacity - size), &read, NULL)) {
      DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA) break;
      fail_message("spawn launcher EINVAL");
    }
    if (read == 0) break;
    size += (int)read;
  }
  *length = size;
  return buffer;
}

int main(void) {
  int json_length = 0;
  char *bytes = read_stdin(&json_length);
  struct Json json = { bytes, bytes + json_length };
  skip_space(&json);
  expect(&json, '{');
  struct WList argv = { 0 };
  struct WString cwd = { 0 };
  struct WString log = { 0 };
  struct EnvList env = { 0 };
  int seen_argv = 0, seen_cwd = 0, seen_log = 0, seen_env = 0;
  skip_space(&json);
  if (peek(&json) != '}') {
    for (;;) {
      struct WString key = parse_string(&json);
      expect(&json, ':');
      if (string_equals(key, L"argv")) {
        if (seen_argv) fail_message("spawn launcher EINVAL");
        argv = parse_argv(&json);
        seen_argv = 1;
      } else if (string_equals(key, L"cwd")) {
        if (seen_cwd) fail_message("spawn launcher EINVAL");
        cwd = parse_string(&json);
        seen_cwd = 1;
      } else if (string_equals(key, L"log")) {
        if (seen_log) fail_message("spawn launcher EINVAL");
        log = parse_string(&json);
        seen_log = 1;
      } else if (string_equals(key, L"env")) {
        if (seen_env) fail_message("spawn launcher EINVAL");
        env = parse_env(&json);
        seen_env = 1;
      } else {
        fail_message("spawn launcher EINVAL");
      }
      skip_space(&json);
      char value = next(&json);
      if (value == '}') break;
      if (value != ',') fail_message("spawn launcher EINVAL");
    }
  }
  skip_space(&json);
  if (json.cursor != json.end) fail_message("spawn launcher EINVAL");
  if (!seen_argv || !seen_cwd || !seen_log || !seen_env || argv.count < 1) fail_message("spawn launcher EINVAL");

  HANDLE log_handle = open_log(log.data);
  HANDLE nul_handle = open_nul();
  wchar_t *command_line = build_command_line(&argv);
  wchar_t *env_block = build_env_block(&env);
  STARTUPINFOW startup = { 0 };
  PROCESS_INFORMATION process = { 0 };
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = nul_handle;
  startup.hStdOutput = log_handle;
  startup.hStdError = log_handle;
  BOOL created = CreateProcessW(
    argv.items[0].data,
    command_line,
    NULL,
    NULL,
    TRUE,
    CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
    env_block,
    cwd.data,
    &startup,
    &process
  );
  if (!created) {
    DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
      wchar_t found[MAX_PATH];
      DWORD searched = SearchPathW(NULL, argv.items[0].data, L".exe", MAX_PATH, found, NULL);
      if (searched > 0 && searched < MAX_PATH) {
        created = CreateProcessW(
          found,
          command_line,
          NULL,
          NULL,
          TRUE,
          CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
          env_block,
          cwd.data,
          &startup,
          &process
        );
        error = created ? 0 : GetLastError();
      }
    }
    if (!created) fail_spawn(argv.items[0].data, spawn_code(error));
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(log_handle);
  CloseHandle(nul_handle);
  return 0;
}
