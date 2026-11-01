/**
 * Plain-language meaning of a kernel exit. Texts are catalog keys for t().
 * Windows reports NTSTATUS values as the exit code; macOS reports a signal.
 */
export interface ExitExplanation {
  /** 0x80000003, SIGTRAP, ... */
  code: string
  title: string
  hint: string
}

const WINDOWS: Record<number, Omit<ExitExplanation, 'code'>> = {
  0x80000003: { title: '内核断言失败（CHECK）', hint: '内核检查到不允许的状态后主动崩溃，多数是某个启动参数或指纹设置触发的，看下面的崩溃原因和日志' },
  0xC0000005: { title: '内存访问违规', hint: '内核读写了无效内存，可能是内核本身的问题，换一个内核版本试试' },
  0xC0000409: { title: '内核检测到严重错误后立即终止', hint: '多数由内核内部检查触发，看下面的崩溃原因和日志' },
  0xC000001D: { title: 'CPU 不支持内核使用的指令', hint: '内核编译时用的指令集这台电脑的 CPU 不支持，换一个内核版本' },
  0xC00000FD: { title: '栈溢出', hint: '内核递归过深崩溃，换一个内核版本试试' },
  0xC0000135: { title: '缺少 DLL 文件', hint: '内核文件不完整，到内核管理里重新安装这个内核' },
  0xC0000142: { title: 'DLL 初始化失败', hint: '常见于安全软件拦截或系统资源不足，关掉安全软件或重启电脑后再试' },
  0xC0000022: { title: '没有权限', hint: '内核被安全软件拦截或文件权限不足' },
  0xC0000017: { title: '内存不足', hint: '电脑可用内存不够，关掉一些窗口后再试' },
  0xE0000008: { title: '内存不足', hint: '电脑可用内存不够，关掉一些窗口后再试' }
}

const SIGNALS: Record<string, Omit<ExitExplanation, 'code'>> = {
  SIGTRAP: WINDOWS[0x80000003],
  SIGSEGV: WINDOWS[0xC0000005],
  SIGBUS: WINDOWS[0xC0000005],
  SIGILL: WINDOWS[0xC000001D],
  SIGABRT: { title: '内核主动中止', hint: '内核检查到严重错误后中止，看下面的崩溃原因和日志' },
  SIGKILL: { title: '进程被强制结束', hint: '被系统或其他程序结束，常见于内存不足' }
}

const UNKNOWN = { title: '内核异常退出', hint: '看下面的日志找出原因' }

export function explainExit(code: number | null, signal: string | null): ExitExplanation {
  if (signal) return { code: signal, ...(SIGNALS[signal] ?? UNKNOWN) }
  if (code === null) return { code: '-', ...UNKNOWN }
  const status = code >>> 0
  const hex = `0x${status.toString(16).toUpperCase().padStart(8, '0')}`
  if (WINDOWS[status]) return { code: hex, ...WINDOWS[status] }
  return { code: status > 0xFFFF ? hex : String(code), ...UNKNOWN }
}
