
import type { Context } from '@deepseek-ai/cordis'
import type { GreeterService } from './greeter'

export const name = 'greeter-consumer'
export const inject = ['greeter']

export function apply(ctx: Context) {
  const greeter: GreeterService = ctx.greeter

  const result = greeter.greet('Ada')

  console.log('[consumer]', result)
}
