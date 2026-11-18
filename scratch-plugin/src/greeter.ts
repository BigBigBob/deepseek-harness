
import { Service, type Context } from '@deepseek-ai/cordis'

// 扩展 Context 类型
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

// 定义服务
export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(name: string): string {
    return `Hello, ${name}!`
  }
}

// 定义插件入口
export const name = 'greeter-provider'

export function apply(ctx: Context) {
  console.log('[provider] loading')
  ctx.plugin(GreeterService)
}
