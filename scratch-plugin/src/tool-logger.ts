
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

// 1. 插件名称
export const name = 'tool-logger'

// 2. 声明依赖 ToolsService
export const inject = ['tools']

// 3. 插件入口函数
export function apply(ctx: Context) {
  console.log('[tool-logger] Plugin loaded')

  // 4. 监听工具执行完成事件
  ctx.on('tools/result', (exec, result) => {
    try {
      // 工具名称
      const toolName = exec.name

      // 工具调用参数
      const args = JSON.stringify(exec.arguments)

      // 是否执行成功
      const success = !result.isError

      // 只提取文本类型的结果
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')

      // 截断结果，避免输出太长
      const preview = text.slice(0, 200)

      console.log('\n========== TOOL LOG ==========')
      console.log(`[tool-logger] Tool: ${toolName}`)
      console.log(`[tool-logger] Arguments: ${args}`)
      console.log(`[tool-logger] Success: ${success}`)
      console.log(`[tool-logger] Result: ${preview}`)
      console.log('==============================\n')
    } catch (error) {
      console.error('[tool-logger] Logging failed:', error)
    }
  })
}
