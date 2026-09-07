### 一、初步概念
这里的 Cordis 不是模型、Agent 或 Web 框架本身，而是 DeepSeek Harness 底层的“插件运行时”：它同时负责插件装载、依赖注入、服务注册、事件分发和资源生命周期管理。

可以把它粗略理解成：

```text
Cordis
≈ 插件管理器
+ 依赖注入容器
+ 类型化事件总线
+ 生命周期/资源管理器
+ 配置驱动的应用装配器
```

仓库内的官方入门说明在 [cordis-primer.md](E:/code/agent/deepseek-harness/docs/cordis-primer.md) 和 [cordis-tutorial](E:/code/agent/deepseek-harness/docs/cordis-tutorial/index.md)。

#### 1. Cordis 解决什么问题

假设一个 Agent 应用包含这些部分：

- LLM 模型适配器
- 工具注册中心
- 文件系统
- Shell 执行器
- 权限和审批系统
- 会话持久化
- Agent Loop
- Web UI
- 子 Agent

传统写法可能在一个入口里手动实例化：

```ts
const llm = new DeepSeekLlm(...)
const fs = new LocalFileSystem(...)
const tools = new ToolRegistry(fs)
const agent = new Agent(llm, tools)
const web = new WebServer(agent)
```

这会产生几个问题：

- 组件与具体实现直接耦合；
- 初始化顺序必须人工维护；
- 替换本地文件系统为远程沙箱时，需要修改很多调用者；
- 热更新或卸载组件时，监听器、定时器、进程容易泄漏；
- 测试中很难只替换一个能力。

Cordis 的做法是让各组件只声明：

```text
我提供什么服务
我依赖什么服务
我监听什么事件
我安装了哪些需要清理的资源
```

Cordis 再负责把它们装配起来。

#### 2. 六个核心概念

##### Context：当前插件所处的运行环境

`Context` 通常命名为 `ctx`。它是服务、事件和生命周期 API 的统一入口：

```ts
ctx.tools
ctx.llm
ctx.sessions

ctx.plugin(...)
ctx.on(...)
ctx.emit(...)
ctx.effect(...)
```

它不只是一个全局对象。不同插件、Agent 或隔离组可以拥有不同的 Context，因而看到不同的服务实例。

例如同一个进程中，两个 Agent 可以分别使用不同的 Shell Provider：

```text
Agent A Context → 本地 Shell
Agent B Context → 远程 E2B Shell
```

调用者仍然只访问 `ctx.shell`，不用知道背后是哪一种实现。

##### Plugin：向 Context 贡献行为的单元

Cordis 支持三种插件形式。

函数插件： (Q1)

```ts
/**
hello 是一个插件函数：
- 参数 ctx 是 Cordis 传入的上下文。
- Context 是 TypeScript 类型，表示它可以访问服务、事件和生命周期 API。
- 插件被加载时，Cordis 会调用 hello(ctx)。
- 因此它会输出：hello
**/

function hello(ctx: Context) {
  console.log('hello')
}

/**
表示把 hello 挂载为当前插件的子插件。执行过程近似于：

**/
await ctx.plugin(hello)
```

模块形式通常导出 `apply`：

```ts
export const name = 'hello'

export function apply(ctx: Context) {
  console.log('hello')
}
```

对象插件： Q5

```ts
const plugin = {
  name: 'hello',
  apply(ctx: Context) {
    console.log('hello')
  },
}
```

Service 类插件：Q6

```ts
class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }
}
```

DeepSeek Harness 中几乎所有功能都是这种插件，包括 LLM、Session、Tools，甚至 Agent Loop 本身。

### Service：插件直接调用的能力

Service 是注册在 `ctx.<name>` 上的命名能力。

例如：

```ts
ctx.llm.stream(...)
ctx.tools.execute(...)
ctx.sessions.get(...)
```

Provider 通过继承 `Service` 注册能力：

```ts
class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(name: string): string {
    return `Hello, ${name}!`
  }
}
```

`super(ctx, 'greeter')` 的含义是：

```text
把当前实例注册为 ctx.greeter
```

其他插件不需要导入具体实例，只访问 `ctx.greeter`。

### inject：声明服务依赖

消费者这样声明依赖：

```ts
export const inject = ['greeter']
```

然后就可以安全使用：

```ts
export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('world'))
}
```

如果 `greeter` 尚未注册，Cordis 不会立即执行这个插件，而是让它停留在 `PENDING` 状态。

当 Provider 出现时，消费者自动激活；当 Provider 被卸载时，消费者也会被卸载；Provider 再回来时，消费者重新加载。

因此配置文件中的行顺序不等于启动顺序：

```yaml
- name: './consumer.ts'
- name: './greeter.ts'
```

即使消费者写在前面，它仍然会等待 `greeter`。

插件实例对应一个 Fiber，其状态大致是：

```text
PENDING
   ↓
LOADING → ACTIVE
   ↓         ↓
FAILED   UNLOADING → DISPOSED
```

需要注意：缺少依赖导致的 `PENDING` 是合法状态，不一定抛错。因此插件“没有执行也没有报错”时，首先应检查 Fiber 是否正在等待服务。

### Event：插件之间的松耦合通信

Service 适合直接调用：

```ts
ctx.greeter.greet('Alice')
```

Event 适合广播、观察或拦截：

```ts
ctx.emit('greeter/greeted', 'Alice', 'Hello, Alice!')
```

监听：

```ts
ctx.on('greeter/greeted', (name, message) => {
  console.log(name, message)
})
```

发送方不需要知道有多少监听者，也不需要导入监听插件。

Cordis 有几种事件分发模式：

| 模式 | 用途 |
|---|---|
| `emit` | 同步广播，监听者只观察 |
| `parallel` | 并行执行并等待全部监听者 |
| `serial` | 按顺序执行并等待 |
| `bail` | 第一个给出结果的监听者终止分发 |
| `waterfall` | 中间件管线，可以包装或截断后续处理 |

Harness 中尤其重要的是 `waterfall`：

```ts
ctx.on('demo/transform', async (input, next) => {
  const result = await next()
  return result.toUpperCase()
})
```

`next()` 表示继续调用下一个监听者或最终实现。

也可以故意短路：

```ts
ctx.on('demo/transform', async (input, next) => {
  if (input.includes('blocked')) {
    return '请求被拦截'
  }

  return next()
})
```

Harness 的模型请求、工具审批和工具执行策略大量使用这种机制，例如：

```text
agent/request
tools/pre-execute
tools/execute
tools/post-execute
approval/request
```

最常见的错误是：监听者本来只是记录日志，却忘记调用 `next()`，导致真正的操作永远不执行。

### Effect：自动清理资源

插件可能注册事件、定时器、文件监听器、网络连接或子进程。Cordis 要求这些资源跟随插件生命周期一起释放。

对于 Cordis 自带 API：

```ts
ctx.on('demo/event', listener)
ctx.plugin(childPlugin)
```

它们本身就是 Effect，插件卸载时会自动撤销。

外部资源要使用 `ctx.effect()`：

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log('tick')
    }, 1000)

    return () => {
      clearInterval(timer)
      console.log('timer cleaned')
    }
  })
}
```

插件被热更新、配置移除或依赖消失时，返回的 disposer 会自动执行。

这也是 Cordis 能可靠实现热更新的重要基础：

```text
卸载旧插件
 → 撤销监听器
 → 关闭定时器/连接
 → 注销服务
 → 加载新插件
 → 重新激活依赖者
```

## 3. 一个可以运行的入门示例

可以在仓库的 `tmp/cordis-demo` 下创建三个文件。`tmp/` 已被 Git 忽略，不会污染版本控制。

### `greeter.ts`  Q8

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }

  interface Events {
    'greeter/greeted'(name: string, message: string): void
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    // 将当前服务注册为 ctx.greeter
    super(ctx, 'greeter')
  }

  greet(name: string): string {
    const message = `Hello, ${name}!`

    // 广播一个类型化事件
    this.ctx.emit('greeter/greeted', name, message)

    return message
  }
}

export const name = 'greeter-provider'

export function apply(ctx: Context): void {
  // Service 类本身也是插件
  ctx.plugin(GreeterService)
}
```

这里有两套注册。

运行时注册：

```ts
super(ctx, 'greeter')
```

TypeScript 类型注册：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

后者只是声明合并，不会生成运行时代码；前者才真正注册服务。

### `consumer.ts`

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from './greeter.ts'

export const name = 'greeter-consumer'

// greeter 不存在时，这个插件保持 PENDING
export const inject = ['greeter']

export function apply(ctx: Context): void {
  // ctx.on 注册的监听器会在插件卸载时自动移除
  ctx.on('greeter/greeted', (name, message) => {
    console.log(`[event] ${name} -> ${message}`)
  })

  const result = ctx.greeter.greet('Cordis')
  console.log(`[return] ${result}`)
}
```

`import type {}` 不产生运行时依赖，只是让 TypeScript 看到 `greeter.ts` 中的声明合并。

### `cordis.yml`  Q9

```yaml
- id: consumer
  name: './consumer.ts'

- id: greeter
  name: './greeter.ts'
```

消费者故意写在 Provider 前面。它仍然可以正常工作，因为真正决定激活顺序的是：

```ts
export const inject = ['greeter']
```

而不是 YAML 的排列顺序。

### 运行

在 `tmp/cordis-demo` 目录执行：  Q10

```sh
node --import tsx ../../vendor/cordis/bin.js
```

预期输出：

```text
[event] Cordis -> Hello, Cordis!
[return] Hello, Cordis!
```

启动器会：

```text
创建根 Context
 → 加载 Cordis Loader
 → 读取 cordis.yml
 → 创建 consumer Fiber
 → consumer 等待 greeter
 → 加载 greeter Provider
 → 注册 ctx.greeter
 → 激活 consumer
 → 注册事件监听器
 → 调用 ctx.greeter.greet()
```

## 4. 它在 DeepSeek Harness 中如何使用

把示例中的名称替换一下，就能看到 Harness 的结构：

```text
GreeterService       → LlmRuntime / ToolRuntime / SessionStore
ctx.greeter          → ctx.llm / ctx.tools / ctx.sessions
consumer.ts          → Agent Loop、UI 或工具插件
greeter/greeted      → agent/*、tools/*、session/*
cordis.yml           → profile 和 bundle patch
```

例如 Agent Loop 不直接构造 DeepSeek Provider。它访问： Q11

```ts
ctx.llm.stream(request)
```

工具调用也不直接实例化每一个工具，而是访问：

```ts
ctx.tools.execute(execution)
```

默认具体实现由 [base/cordis.patch.yml](E:/code/agent/deepseek-harness/packages/bundle/base/cordis.patch.yml) 决定。替换 Provider 通常只需要改变配置，不需要修改 Agent Loop。

一句话概括：

> Cordis 让 DeepSeek Harness 的每个功能都成为可装载、可替换、可观察、可卸载，并且具有明确依赖和清理行为的插件。


---



## Q1QQQQQ这段代码演示了 Cordis 最简单的“函数插件”。

```ts
function hello(ctx: Context) {
  console.log('hello')
}
```

`hello` 是一个插件函数：

- 参数 `ctx` 是 Cordis 传入的上下文。
- `Context` 是 TypeScript 类型，表示它可以访问服务、事件和生命周期 API。
- 插件被加载时，Cordis 会调用 `hello(ctx)`。
- 因此它会输出：

```text
hello
```

然后：

```ts
await ctx.plugin(hello)
```

表示把 `hello` 挂载为当前插件的子插件。执行过程近似于：

```text
创建 hello 的插件实例 Fiber
 → 为它准备 Context
 → 调用 hello(ctx)
 → 等待插件成功激活
```

这里的 `await` 很重要：  Q2

- 等待插件完成加载；
- 如果插件加载失败，让错误传播给当前调用者；
- 避免后续代码在插件尚未就绪时执行。

例如：

```ts
function hello(ctx: Context) {
  throw new Error('加载失败')
}

await ctx.plugin(hello)
console.log('不会执行到这里')
```

`ctx.plugin()` 还会建立生命周期关系：`hello` 是当前插件的子插件。当父插件卸载时，Cordis 会自动卸载 `hello` 以及它注册的监听器、服务和 Effect。

如果需要主动卸载，可以保留返回的 Fiber：

```ts
const fiber = ctx.plugin(hello)

await fiber
await fiber.dispose()
```

更实际一点的函数插件可以这样写：

```ts
import type { Context } from '@deepseek-ai/cordis'

function hello(ctx: Context) {
  ctx.on('app/ready', () => {
    console.log('应用已经就绪')
  })
}

const fiber = ctx.plugin(hello)
await fiber
```

此时插件不仅执行一次代码，还向 Cordis 注册了事件监听器。插件卸载时，这个监听器会自动移除。

一句话概括：

```ts
await ctx.plugin(hello)
```

就是“把 `hello` 作为一个受 Cordis 管理、拥有独立生命周期的子插件加载进来，并等待它加载完成”。

---

## Q2QQQQawait关键字的作用是什么？

`await` 的作用是：等待一个异步操作完成，并取得它成功返回的结果。

例如：

```ts
const result = await someAsyncOperation()
```

相当于说：

> 暂停当前 `async` 函数后续代码，等 `someAsyncOperation()` 完成后，再把结果赋给 `result`。

## 基本例子

```ts
async function main() {
  console.log('开始')

  await new Promise(resolve => {
    setTimeout(resolve, 1000)
  })

  console.log('一秒后继续')
}

main()
```

输出顺序是：

```text
开始
一秒后继续
```

如果没有 `await`：

```ts
async function main() {
  console.log('开始')

  new Promise(resolve => {
    setTimeout(resolve, 1000)
  })

  console.log('立即继续')
}
```

程序不会等待这一秒。

## `await` 不会阻塞整个程序

`await` 只暂停当前 `async` 函数，不会阻塞 JavaScript 线程。 Q3

```ts
async function task() {
  console.log('task 开始')
  await new Promise(resolve => setTimeout(resolve, 1000))
  console.log('task 结束')
}

task()
console.log('外部代码')
```

输出：

```text
task 开始
外部代码
task 结束
```

在等待期间，JavaScript 仍然可以执行其他代码和处理其他事件。

## 获取异步结果

```ts
async function getNumber(): Promise<number> {
  return 42
}

async function main() {
  const number = await getNumber()
  console.log(number)
}
```

输出：

```text
42
```

`await` 会“解开”Promise，取得里面的 `42`。

## 处理失败

如果被等待的 Promise 失败，`await` 会抛出异常：

```ts
async function main() {
  try {
    const result = await Promise.reject(
      new Error('请求失败'),
    )

    console.log(result)
 /adqq
  catch (error) {
    console.log('捕获错误：', error)
  }
}
```

通常写成：

```ts
try {
  await doSomething()
} catch (error) {
  console.error('操作失败', error)
}
```

## 在 Cordis 代码中的含义

原来的代码是：

```ts
await ctx.plugin(hello)
```

这里可以理解为：

```text
开始加载 hello 插件
 → 等待插件完成初始化
 → 初始化成功后继续执行下一行
 → 初始化失败则抛出错误
```

例如：

```ts
async function main(ctx: Context) {
  await ctx.plugin(hello)

  console.log('hello 插件已经加载完成')
}
```

如果不写 `await`：

```ts
ctx.plugin(hello)

console.log('这时插件可能还没有加载完成')
```

后面的代码可能在插件完成初始化前执行，而且异步加载错误也可能无法在当前位置被正常捕获。

## `await` 可以在哪里使用

通常只能在 `async` 函数里使用：

```ts
async function main() {
  await doSomething()
}
```

也可以在支持顶层 `await` 的 ESM 模块中直接使用：

```ts
// package.json 包含 "type": "module"
await doSomething()
```

DeepSeek Harness 使用 ESM，因此示例中的顶层写法是合法的。

简化记忆：

```ts
const promise = doSomething()
const result = await promise
```

意思就是：

> 等这个异步任务完成；成功则拿到结果，失败则在这里抛出错误。

---

## Q3QQQQQQawait需要和async一起使用吗？

通常需要，但有一个重要例外。

### 1. 函数内部：所在函数必须是 `async`

正确：

```ts
async function main() {
  const result = await doSomething()
  console.log(result)
}
```

错误：

```ts
function main() {
  const result = await doSomething()
}
```

通常会得到语法错误，因为普通函数内部不能使用 `await`。

箭头函数同样如此：

```ts
const main = async () => {
  await doSomething()
}
```

### 2. ESM 模块顶层：不需要 `async`

在 ES Module 中可以使用顶层 `await`：  Q4

```ts
import { Context } from '@deepseek-ai/cordis'

const ctx = new Context()

await ctx.plugin(hello)
```

不需要再包一层：

```ts
async function main() {}
```

DeepSeek Harness 使用 ESM——`package.json` 中设置了：

```json
{
  "type": "module"
}
```

所以之前的示例可以直接写：

```ts
await ctx.plugin(hello)
```

### 3. `async` 和 `await` 的关系

- `async`：声明这个函数是异步函数，它一定返回 Promise。
- `await`：等待一个 Promise 完成，并取得结果。
- `await` 通常只能出现在 `async` 函数或 ESM 模块顶层。

例如：

```ts
async function getNumber() {
  return 42
}

const promise = getNumber()
const number = await promise
```

即使返回的是普通值，`async` 也会把它包装成 Promise：

```ts
getNumber() // Promise<number>
```

最简单的记法是：

> 函数里面使用 `await`，就给函数加上 `async`；ESM 文件顶层使用 `await`，则不需要额外的 `async`。





## Q4QQQQQ什么是ES Module？

ES Module，简称 ESM，是 JavaScript 官方标准化的模块系统。注释 1

它的作用是把程序拆分成多个文件，并明确声明：

- 当前文件向外提供什么；
- 当前文件需要使用其他文件的什么。

## 1. 最简单的例子

`math.js` 导出函数：

```
export function add(a, b) {
  return a + b
}

export const PI = 3.14159
```

`main.js` 导入并使用：

```
import { add, PI } from './math.js'

console.log(add(2, 3))
console.log(PI)
```

其中：

- `export` 表示向其他模块公开内容；
- `import` 表示从其他模块引入内容。

每个文件就是一个独立模块，模块内部的变量默认不会泄漏到全局。

## 2. 默认导出

一个模块可以有一个默认导出：

```
// logger.js
export default function log(message) {
  console.log(message)
}
```

导入默认导出时不需要花括号：

```
import log from './logger.js'

log('Hello')
```

导入者也可以自行命名：

```
import print from './logger.js'

print('Hello')
```

## 3. 命名导出

一个模块可以有多个命名导出：

```
export function add(a, b) {
  return a + b
}

export function subtract(a, b) {
  return a - b
}
```

导入时使用花括号，并且名称需要匹配：

```
import { add, subtract } from './math.js'
```

也可以重命名：

```
import { add as sum } from './math.js'

console.log(sum(1, 2))
```

或者导入整个模块：

```
import * as math from './math.js'

console.log(math.add(1, 2))
console.log(math.subtract(5, 3))
```

## 4. 浏览器如何使用 ESM

在浏览器中，需要为脚本添加 `type="module"`：

```
<script type="module" src="./main.js"></script>
```

模块脚本与普通脚本相比有几个特点：

- 可以使用 `import` 和 `export`；
- 默认启用严格模式；
- 每个模块都有独立作用域；
- 默认延迟执行，类似 `defer`；
- 相同模块通常只加载、执行一次。

浏览器中的相对导入一般必须写完整路径：

```
import { add } from './math.js'
```

不能随意省略 `./`。

## 5. Node.js 如何识别 ESM

Node.js 常见有两种方式。

使用 `.mjs` 扩展名：

```
main.mjs
math.mjs
```

或者在 `package.json` 中声明：

```
{
  "type": "module"
}
```

声明之后，该包下面的 `.js` 文件默认按照 ESM 解释：

```
import { readFile } from 'node:fs/promises'
```

当前 DeepSeek Harness 的根 `package.json` 就使用了：

```
{
  "type": "module"
}
```

所以项目采用 ESM 语法。

## 6. ESM 为什么支持顶层 `await`

ESM 的加载过程本身可以是异步的，所以模块顶层允许使用 `await`：

```
const response = await fetch('https://example.com/data.json')
const data = await response.json()

export default data
```

导入这个模块的其他模块会等待它完成初始化。

因此下面这种 Cordis 代码可以直接写在 ESM 文件顶层：

```
const ctx = new Context()

await ctx.plugin(hello)
```

如果是普通 JavaScript 脚本，顶层通常不能使用 `await`。

## 7. ESM 与 CommonJS 的区别

Node.js 早期主要使用 CommonJS：

```
// CommonJS 导出
module.exports = {
  add,
}

// CommonJS 导入
const { add } = require('./math')
```

ESM 使用：

```
// ESM 导出
export { add }

// ESM 导入
import { add } from './math.js'
```

核心差异如下：

| ESM                  | CommonJS                     |
| -------------------- | ---------------------------- |
| `import` / `export`  | `require` / `module.exports` |
| JavaScript 官方标准  | Node.js 早期模块规范         |
| 支持浏览器和 Node.js | 主要用于 Node.js             |
| 支持顶层 `await`     | 通常不支持顶层 `await`       |
| 导入结构可静态分析   | `require()` 可以动态执行     |
| 模块加载偏异步       | 传统 `require()` 是同步加载  |

ESM 的静态结构让 TypeScript、打包器和编辑器更容易分析依赖：

```
import { add } from './math.js'
```

在代码执行前前，就能大致确定它依赖哪个模块、导入哪些成员。

## 8. TypeScript 中的 ESM

TypeScript 的写法基本相同：

```
// user.ts
export interface User {
  name: string
}

export function createUser(name: string): User {
  return { name }
}
```

导入：

```
import { createUser } from './user.js'
import type { User } from './user.js'

const user: User = createUser('Alice')
```

这里的：

```
import type { User } from './user.js'
```

只导入类型。编译为 JavaScript 后，这行通常会被删除，因为 JavaScript 运行时不需要 TypeScript 类型。

一句话概括：

> ES Module 是 JavaScript 官方的文件模块化机制，用 `export` 公开内容，用 `import` 使用其他模块，并支持独立作用域、静态依赖分析和顶层 `await`。



## Q5QQQQQQQ

这段代码定义了一个最简单的 Cordis“对象插件”：

```
const plugin = {
  name: 'hello',
  apply(ctx: Context) {
    console.log('hello')
  },
}
```

逐行解释如下。

```
const plugin = {
```

创建一个普通 JavaScript 对象，并将它保存到常量 `plugin` 中。Cordis 会根据对象中的特定字段，把它识别为插件。

```
name: 'hello',
```

`name` 是插件名称，主要用于日志和诊断。

例如 Cordis 报告插件加载失败时，可以显示：

```
plugin hello failed
```

它不是服务名称，也不会创建 `ctx.hello`。如果要提供服务，需要继承 `Service` 并注册服务键。

```
apply(ctx: Context) {
```

`apply` 是插件的入口函数。Cordis 挂载该插件时会调用它。

这里是 TypeScript 的方法简写，等价于：

```
apply: function (ctx: Context) {
  // ...
}
```

参数 `ctx` 是当前插件的 Cordis Context。插件通过它访问或注册各种能力：

```
ctx.plugin(...)  // 挂载子插件
ctx.on(...)      // 监听事件
ctx.emit(...)    // 发送事件
ctx.effect(...)  // 注册需要自动清理的资源
ctx.tools        // 使用 Harness 的工具服务
ctx.llm          // 使用 LLM 服务
```

`Context` 是 TypeScript 类型标注，只在编译检查时存在，不会改变运行行为。

```
console.log('hello')
```

插件加载时输出一次 `hello`。

因此，执行：

```
await ctx.plugin(plugin)
```

大致会发生：

```
Cordis 创建插件 Fiber
        ↓
Fiber 进入 LOADING
        ↓
调用 plugin.apply(ctx)
        ↓
控制台输出 hello
        ↓
apply 正常结束
        ↓
Fiber 进入 ACTIVE
```

完整示例：

```
import { Context } from '@deepseek-ai/cordis'

const plugin = {
  name: 'hello',

  apply(ctx: Context) {
    console.log('hello')
  },
}

const ctx = new Context()

const fiber = await ctx.plugin(plugin)

// 卸载插件，并等待其资源清理完成
await fiber.dispose()
```

这个插件目前没有使用 `ctx`，所以也可以写成：

```
const plugin = {
  name: 'hello',

  apply() {
    console.log('hello')
  },
}
```

不过保留 `ctx` 通常是为了接下来注册事件或资源。例如：

```
const plugin = {
  name: 'hello',

  apply(ctx: Context) {
    ctx.on('demo/message', (message) => {
      console.log(message)
    })
  },
}
```

这里注册的监听器属于这个插件。插件卸载时，Cordis 会自动移除监听器。

对象插件也可以从模块导出：

```
export default {
  name: 'hello',

  apply(ctx: Context) {
    console.log('hello')
  },
}
```

最关键的理解是：

> 这个对象描述了“插件叫什么，以及插件加载时做什么”；真正负责调用 `apply`、跟踪插件状态和清理资源的是 Cordis。



## Q6QQQQQQQ

这段代码定义了一个 Cordis 服务类，并把它注册为 `ctx.greeter`：

```
class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }
}
```

逐行来看。

```
class GreeterService extends Service {
```

声明一个名为 `GreeterService` 的类，并继承 Cordis 提供的 `Service` 基类。

普通插件主要执行一些注册操作；Service 插件则额外提供一个可被其他插件直接调用的能力。例如后续可以写：

```
ctx.greeter.greet('Alice')
constructor(ctx: Context) {
```

构造函数接收当前 Cordis 上下文 `ctx`。

这个 Context 决定：

- 服务注册到哪个插件环境；
- 哪些插件能访问该服务；
- 服务的生命周期归谁管理；
- 服务卸载时哪些依赖插件需要重启或停止。

```
super(ctx, 'greeter')
```

调用父类 `Service` 的构造函数。

两个参数分别表示：

```
super(
  ctx,        // 服务所属的 Cordis Context
  'greeter',  // 服务注册键
)
```

关键效果是：

```
GreeterService 实例 → 注册为 ctx.greeter
```

可以把它近似理解为 Cordis 内部执行了：

```
ctx.services.set('greeter', this)
```

但实际实现还会管理依赖关系、插件作用域和自动卸载。

目前这个类没有定义任何业务方法，所以 `ctx.greeter` 暂时只能拿到一个空服务实例。通常会继续添加方法：

```
class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(name: string): string {
    return `Hello, ${name}!`
  }
}
```

然后将它作为插件挂载：

```
await ctx.plugin(GreeterService)
```

其他插件便可以消费它：

```
export const inject = ['greeter']

export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('Alice'))
}
```

输出：

```
Hello, Alice!
```

还需要补充 TypeScript 类型声明，否则运行时虽然存在 `ctx.greeter`，TypeScript 却不知道它： Q7

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

完整写法如下：

```
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(name: string): string {
    return `Hello, ${name}!`
  }
}
```

这里包含两个不同层面的注册：

```
super(ctx, 'greeter')
    → 运行时注册，让服务实际出现在 ctx.greeter

interface Context { greeter: GreeterService }
    → TypeScript 类型声明，让编辑器和编译器认识 ctx.greeter
```

最后，`Service` 自身也是一种 Cordis 插件。因此 Provider 被卸载时：

```
GreeterService 卸载
 → ctx.greeter 被注销
 → 依赖 greeter 的插件被卸载或进入等待状态
 → Provider 恢复后，依赖插件重新激活
```

一句话概括：

> `GreeterService` 是服务实现类，`extends Service` 让它参与 Cordis 生命周期，`super(ctx, 'greeter')` 则把其实例注册为当前上下文中的 `ctx.greeter` 服务。



## Q7QQQQQQ

这段代码使用了 TypeScript 的“模块扩充（Module Augmentation）”和“声明合并（Declaration Merging）”，让 TypeScript 知道 Cordis 的 `Context` 上存在 `greeter` 属性。注释 1

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

逐层解释。

```
declare module '@deepseek-ai/cordis' {
```

这里不是创建新模块，也不是修改 Cordis 源代码，而是在扩充已经存在的 `@deepseek-ai/cordis` 模块类型。

可以理解成对 TypeScript 说：

> 请在 `@deepseek-ai/cordis` 原有类型声明的基础上，补充下面这些类型信息。

```
interface Context {
```

Cordis 本身已经声明了 `Context`。TypeScript 允许同名接口进行声明合并，因此这里不会覆盖原来的接口，而是向其中增加成员。

假设 Cordis 原来的类型近似是：

```
interface Context {
  plugin(...args: unknown[]): unknown
  emit(...args: unknown[]): void
  on(...args: unknown[]): () => void
}
```

扩充后，TypeScript 会把它理解为：

```
interface Context {
  plugin(...args: unknown[]): unknown
  emit(...args: unknown[]): void
  on(...args: unknown[]): () => void

  greeter: GreeterService
}
```

最后这一行：

```
greeter: GreeterService
```

表示：

- `ctx` 上有一个名为 `greeter` 的属性；
- 该属性的类型是 `GreeterService`；
- 因此可以获得自动补全和类型检查。

例如：

```
ctx.greeter.greet('Alice')
```

编辑器知道：

```
ctx.greeter       是 GreeterService
ctx.greeter.greet 是 GreeterService.greet 方法
```

如果调用不存在的方法：

```
ctx.greeter.sayGoodbye()
```

TypeScript 会报错：

```
Property 'sayGoodbye' does not exist on type 'GreeterService'
```

## 它不会注册运行时服务

非常重要的是，这段代码只影响 TypeScript 类型系统：

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

它编译成 JavaScript 后会完全消失，不会真的创建 `ctx.greeter`。

真正的运行时注册由下面这行完成：

```
super(ctx, 'greeter')
```

所以两部分需要配合：

```
class GreeterService extends Service {
  constructor(ctx: Context) {
    // 运行时注册
    super(ctx, 'greeter')
  }
}

// 编译期类型注册
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

它们的职责是：

| 代码                                            | 作用                                 |
| ----------------------------------------------- | ------------------------------------ |
| `super(ctx, 'greeter')`                         | 运行时把服务注册到 `ctx.greeter`     |
| `interface Context { greeter: GreeterService }` | 告诉 TypeScript `ctx.greeter` 的类型 |

如果只有类型声明：

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

TypeScript 会允许你写：

```
ctx.greeter.greet('Alice')
```

但如果服务没有实际加载，运行时仍可能遇到：

```
ctx.greeter is undefined
```

因此消费者还应该声明依赖：

```
export const inject = ['greeter']

export function apply(ctx: Context) {
  // Cordis 会等 greeter 服务出现后才调用 apply
  console.log(ctx.greeter.greet('Alice'))
}
```

## 为什么要这样设计

如果 Cordis 把所有可能出现的服务都预先写进 `Context`：

```
interface Context {
  greeter: GreeterService
  tools: ToolRuntime
  llm: LlmRuntime
  sessions: SessionStore
  // 无数第三方服务……
}
```

那么 Cordis 核心就必须知道所有插件，不再具有扩展性。

使用模块扩充后，每个插件可以自己声明它贡献的服务：

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}
```

另一个插件可以独立扩充：

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    weather: WeatherService
  }
}
```

TypeScript 最终会把它们合并为：

```
interface Context {
  greeter: GreeterService
  weather: WeatherService
}
```

这正适合 Cordis 的插件架构：Cordis 核心不需要预先认识全部服务，服务插件自行扩充 Context 类型。

一句话概括：

> `declare module` 找到 Cordis 已有模块，`interface Context` 与原接口合并，`greeter: GreeterService` 为 `ctx.greeter` 提供静态类型；它只负责类型声明，真正的服务注册仍由 `super(ctx, 'greeter')` 完成。



## Q8QQQQQQQQ

这段代码定义了一个 Cordis 插件。它完成两件事：

1. 注册一个名为 `greeter` 的服务，供其他插件通过 `ctx.greeter` 调用。
2. 每次执行问候时，广播一个 `greeter/greeted` 事件。

整体运行过程是：

```
Cordis 加载模块
  → 调用 apply(ctx)
  → 挂载 GreeterService
  → 注册 ctx.greeter
  → 其他插件调用 ctx.greeter.greet(...)
  → 生成问候文本
  → 广播 greeter/greeted 事件
  → 返回问候文本
```

## 1. 导入 Cordis 类型和基类

```
import { Service, type Context } from '@deepseek-ai/cordis'
```

这里导入了两个东西。

### `Service`

```
Service
```

这是运行时需要的类，所以会保留在编译后的 JavaScript 中。

`GreeterService` 继承它以后，就可以成为 Cordis 管理的服务：

```
export class GreeterService extends Service
```

### `type Context`

```
type Context
```

`Context` 只用于 TypeScript 类型检查：

```
constructor(ctx: Context)
apply(ctx: Context)
```

因为使用了 `type`，编译后这项导入会被删除，不产生运行时代码。

`Context` 可以理解为 Cordis 应用的“运行环境”：

```
ctx.greeter
ctx.tools
ctx.llm

ctx.plugin(...)
ctx.on(...)
ctx.emit(...)
```

## 2. 扩展 Cordis 的 TypeScript 类型

```
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }

  interface Events {
    'greeter/greeted'(name: string, message: string): void
  }
}
```

这叫 TypeScript 模块扩充或声明合并。

它只提供编译期类型，不会在运行时注册任何东西。

### 扩展 `Context`

```
interface Context {
  greeter: GreeterService
}
```

Cordis 原来的 `Context` 类型并不知道存在 `greeter`。这段声明告诉 TypeScript：

```
ctx.greeter 的类型是 GreeterService
```

于是下面的代码可以获得完整的类型检查和代码补全：

```
ctx.greeter.greet('Alice')
```

TypeScript 知道：

- `ctx.greeter` 存在；
- 它是 `GreeterService`；
- 它有 `greet()` 方法；
- `greet()` 接受字符串；
- 返回值也是字符串。

如果没有这段声明，运行时服务仍可能正常注册，但 TypeScript 会报错：

```
Property 'greeter' does not exist on type 'Context'
```

### 扩展 `Events`

```
interface Events {
  'greeter/greeted'(name: string, message: string): void
}
```

这定义了一个类型化事件：

```
事件名：greeter/greeted
参数一：name，字符串
参数二：message，字符串
返回值：void
```

因此下面的发送代码会得到类型检查：

```
ctx.emit('greeter/greeted', 'Alice', 'Hello, Alice!')
```

监听也有类型推导：

```
ctx.on('greeter/greeted', (name, message) => {
  // name 和 message 都会被推导为 string
})
```

如果参数错误，TypeScript 会提醒：

```
// 错误：第二个参数应该是 string
ctx.emit('greeter/greeted', 'Alice', 123)
```

需要特别注意：声明事件不等于发送事件。它只定义事件的类型协议，真正发送发生在后面的 `this.ctx.emit(...)`。

## 3. 定义服务类

```
export class GreeterService extends Service {
```

这里声明了一个公开导出的类，并继承 Cordis 的 `Service`。

之所以使用 `export`，是为了：

- 让其他模块能够引用这个类型；
- 让前面的声明合并可以把 `ctx.greeter` 标记为 `GreeterService`；
- 方便测试或其他插件直接导入。

## 4. 注册服务名称

```
constructor(ctx: Context) {
  super(ctx, 'greeter')
}
```

这是最关键的运行时代码之一。

`super(ctx, 'greeter')` 调用 Cordis `Service` 基类的构造函数，含义是：

```
在当前 Context 中，将这个服务实例注册为 greeter。
```

注册完成后，其他插件就能访问：

```
ctx.greeter
```

其中：

```
'greeter'
```

叫做服务键或 service key。

下面两部分分别负责运行时和编译时：

```
// 运行时真正注册服务
super(ctx, 'greeter')
// 编译时告诉 TypeScript 服务类型
interface Context {
  greeter: GreeterService
}
```

必须理解这一区别：

| 代码                                 | 作用           |
| ------------------------------------ | -------------- |
| `super(ctx, 'greeter')`              | 运行时注册服务 |
| `interface Context { greeter: ... }` | 编译期类型声明 |

如果只有类型声明，没有调用 `super()` 注册，TypeScript 会认为服务存在，但运行时实际上不存在。

如果只有 `super()`，运行时存在服务，但 TypeScript 不认识 `ctx.greeter`。

Cordis 的服务名处在一个共享命名空间中，所以实际项目中应选择不容易冲突的名字。

## 5. 实现问候方法

```
greet(name: string): string {
```

这是普通的 TypeScript 实例方法。

签名表示：

```
输入：name，必须是字符串
输出：字符串
```

例如：

```
ctx.greeter.greet('Alice')
```

返回：

```
Hello, Alice!
```

方法内部首先生成问候语：

```
const message = `Hello, ${name}!`
```

然后广播事件：

```
this.ctx.emit('greeter/greeted', name, message)
```

这里的 `this.ctx` 来自 `Service` 基类。Cordis 在构造服务时保存了所属的 Context，所以服务内部也能：

- 调用其他服务；
- 发送事件；
- 注册监听器；
- 创建 Effect。

这次事件携带两个参数：

```
name
message
```

比如：

```
this.ctx.emit(
  'greeter/greeted',
  'Alice',
  'Hello, Alice!',
)
```

其他插件可以监听：

```
ctx.on('greeter/greeted', (name, message) => {
  console.log(`${name} 收到问候：${message}`)
})
```

最后：

```
return message
```

调用者既可以直接获得返回值，监听者也可以通过事件观察这次操作：

```
直接调用者     ← greet() 返回值
其他观察插件   ← greeter/greeted 事件
```

这种设计很常见：

- Service 方法负责直接能力调用；
- Event 负责通知其他不相关的插件。

## 6. 插件显示名称

```
export const name = 'greeter-provider'
```

这是插件的显示名称或诊断名称。

它主要用于：

- 日志；
- 插件状态展示；
- 错误信息；
- 调试 Fiber；
- Loader 诊断。

它和服务名称不是一回事：

```
export const name = 'greeter-provider'
```

表示插件名称。

```
super(ctx, 'greeter')
```

表示服务名称。

因此可以理解为：

```
插件 greeter-provider 提供了服务 greeter
```

## 7. 插件入口 `apply`

```
export function apply(ctx: Context): void {
  ctx.plugin(GreeterService)
}
```

当 Cordis Loader 加载这个模块时，会调用：

```
apply(ctx)
```

`apply` 接收到当前插件的 Context，然后执行：

```
ctx.plugin(GreeterService)
```

这会把 `GreeterService` 作为一个子插件挂载。

Cordis 发现它继承了 `Service`，于是会创建实例，大致相当于：

```
new GreeterService(ctx)
```

构造函数随后执行：

```
super(ctx, 'greeter')
```

最终完成 `ctx.greeter` 注册。

之所以不直接在 `apply` 中手动创建：

```
// 不推荐
new GreeterService(ctx)
```

而使用：

```
ctx.plugin(GreeterService)
```

是因为后者会让 Cordis 管理它的完整生命周期：

```
父插件卸载
 → 子插件卸载
 → greeter 服务注销
 → 依赖 greeter 的插件随之卸载
 → 相关 Effect 被清理
```

## 8. 其他插件怎样使用它

一个消费者可以这样写：

```
import type { Context } from '@deepseek-ai/cordis'
import type {} from './greeter.ts'

export const name = 'greeter-consumer'
export const inject = ['greeter']

export function apply(ctx: Context): void {
  ctx.on('greeter/greeted', (name, message) => {
    console.log(`观察到事件：${name} -> ${message}`)
  })

  const result = ctx.greeter.greet('Alice')
  console.log(`方法返回：${result}`)
}
```

其中：

```
export const inject = ['greeter']
```

表示这个插件依赖 `greeter` 服务。

如果服务还没准备好，消费者会保持 `PENDING`；等 `GreeterService` 注册完成后，Cordis 才调用消费者的 `apply()`。

运行时的完整顺序是：

```
加载 greeter-provider
 → apply(ctx)
 → ctx.plugin(GreeterService)
 → 创建 GreeterService
 → 注册 ctx.greeter

加载 greeter-consumer
 → 检查 greeter 已存在
 → 注册 greeter/greeted 监听器
 → 调用 ctx.greeter.greet('Alice')
 → GreeterService 生成消息
 → 广播 greeter/greeted
 → consumer 的监听器执行
 → greet() 返回消息
```

输出类似：

```
观察到事件：Alice -> Hello, Alice!
方法返回：Hello, Alice!
```

这段代码最核心的思想，可以压缩成一句话：

```
GreeterService 提供直接调用能力，
Context 暴露这个能力，
Events 提供旁路通知，
apply 负责把它安装进 Cordis，
Cordis 负责它的依赖和生命周期。
```



## Q9QQQQQ

`cordis.yml` 是 Cordis Loader 的“应用装配清单”。它决定一个 Cordis 应用需要加载哪些插件，以及每个插件使用什么配置。

可以把它理解成：

```
package.json     决定项目安装哪些依赖
cordis.yml       决定本次运行启用并装配哪些插件
```

对于这段配置：

```
- id: consumer
  name: './consumer.ts'

- id: greeter
  name: './greeter.ts'
```

Cordis Loader 会创建两个插件条目：

```
consumer → 加载 ./consumer.ts
greeter  → 加载 ./greeter.ts
```

## `name`：插件模块的位置

```
name: './consumer.ts'
```

`name` 是模块标识，可以是相对文件路径：

```
- name: './consumer.ts'
```

也可以是 npm 包名：

```
- name: '@deepseek-ai/dsh-tools'
```

或者包的子模块：

```
- name: '@deepseek-ai/dsh-session/invariant'
```

Loader 加载模块后，通常会寻找并调用它导出的：

```
export function apply(ctx: Context) {
  // 安装插件行为
}
```

因此：

```
- name: './greeter.ts'
```

大致表示：

```
const pluginModule = await import('./greeter.ts')
pluginModule.apply(ctx)
```

实际过程还包括配置校验、依赖等待、Fiber 创建和生命周期管理。

## `id`：配置条目的稳定身份

```
id: greeter
```

`id` 不是服务名称，也不是模块路径，而是这条配置的稳定标识。

例如：

```
- id: greeter
  name: './greeter.ts'
```

其中存在三个不同名字：

```
greeter-provider   插件代码中的显示名称
greeter            cordis.yml 条目 id
./greeter.ts       插件模块位置
```

插件内部还可能注册：

```
super(ctx, 'greeter')
```

这里的 `'greeter'` 又是服务名称。

它们只是碰巧可以写成相同字符串，含义并不相同。

`id` 主要用于：

- 配置更新时识别同一条目；
- 热更新时判断是修改、删除还是新增；
- Patch 精确覆盖某个插件的配置；
- 在诊断输出中定位插件条目；
- 通过 `disabled` 暂停并恢复同一个插件。

例如：

```
- id: greeter
  name: './greeter.ts'
  config:
    greeting: Hello
```

之后把配置改成：

```
- id: greeter
  name: './greeter.ts'
  config:
    greeting: Hi
```

因为 `id` 没变，Loader 知道这是同一个插件条目的配置变化，可以对它执行重新配置或重新挂载。

如果没有显式 `id`，Loader 可能生成临时 ID。配置文件变化后，该条目可能被识别成“删除旧插件，再新增一个插件”，导致不必要的重载。

## YAML 顺序不等于插件启动顺序

配置里 `consumer` 写在 `greeter` 前面：

```
- id: consumer
  name: './consumer.ts'

- id: greeter
  name: './greeter.ts'
```

但这不代表消费者一定先启动。

如果 `consumer.ts` 声明：

```
export const inject = ['greeter']
```

Cordis 会执行：

```
创建 consumer Fiber
 → 发现缺少 greeter 服务
 → consumer 进入 PENDING

加载 greeter.ts
 → 注册 ctx.greeter
 → consumer 的依赖满足
 → 执行 consumer.apply(ctx)
```

所以插件启动顺序由服务依赖决定，不由 YAML 行顺序决定。

这使你可以自由调整配置排列，而不会破坏依赖关系。

## 传递插件配置

`cordis.yml` 还能向插件传递配置：

```
- id: greeter
  name: './greeter.ts'
  config:
    greeting: Hello
    punctuation: '!'
```

插件接收：

```
export interface Config {
  greeting: string
  punctuation: string
}

export function apply(ctx: Context, config: Config): void {
  console.log(config.greeting)
}
```

通常插件还会导出运行时配置 Schema：

```
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
  punctuation: Schema.string().default('!'),
})
```

Loader 会先校验配置，再调用 `apply()`。错误配置会让插件加载失败，而不是带着不完整配置继续运行。

## 启用和禁用插件

可以保留配置，但暂时不挂载插件：

```
- id: greeter
  name: './greeter.ts'
  disabled: true
```

这时：

- `greeter` 条目仍然存在；
- `GreeterService` 不会挂载；
- `ctx.greeter` 不存在；
- 依赖 `greeter` 的消费者会保持 `PENDING`。

改回：

```
disabled: false
```

Provider 会重新挂载，消费者也会自动恢复。

`disabled` 还支持项目使用的 `!!js` 条件表达式：

```
- id: windows-tool
  name: './windows-tool.ts'
  disabled: !!js process.platform !== 'win32'
```

## 分组和隔离

配置还可以把插件组织成组：

```
- id: agent-a
  group: true
  config:
    - id: greeter
      name: './greeter.ts'

    - id: consumer
      name: './consumer.ts'
```

组可以统一装载和卸载。

更复杂的配置可以使用 `isolate`，让不同插件组拥有各自的服务实例。例如：

```
Agent A → 自己的 shell Provider
Agent B → 自己的 shell Provider
```

两边都访问 `ctx.shell`，但实际得到不同实例。

## 在 DeepSeek Harness 中的作用

DeepSeek Harness 并不是把所有功能写死在入口文件里，而是通过配置装配：

```
LLM Provider
Session Store
Agent Registry
Agent Loop
Tools
Filesystem
Sandbox
Approval
Web UI
```

例如默认基础配置在 [base/cordis.patch.yml](E:/code/agent/deepseek-harness/packages/bundle/base/cordis.patch.yml)。

实际启动过程大致是：

```
dsh CLI
 → 选择 Profile
 → 读取 Profile 包含的 Bundle
 → 合并 Bundle patch
 → 合并用户 cordis.patch.yml
 → 得到最终插件条目列表
 → Cordis Loader 装载插件树
```

所以在简单 Cordis 示例中，`cordis.yml` 是完整应用清单；在 DeepSeek Harness 中，相同思想进一步扩展为：

```
Profile + Bundle patches + 用户 patch
```

一句话总结：

> `cordis.yml` 描述“这个应用由哪些插件组成”，而插件代码描述“每个插件具体提供什么行为”。



## Q10QQQQQQQQ

这条命令用于启动一个由 `cordis.yml` 配置的 Cordis 应用，并允许其中的插件直接使用 TypeScript：

```
node --import tsx ../../vendor/cordis/bin.js
```

逐段解释：

- `node`：启动 Node.js。
- `--import tsx`：在运行入口文件前加载 `tsx`，让 Node 能直接导入 `.ts` 文件，而不必先运行 `tsc` 编译。
- `../../vendor/cordis/bin.js`：执行仓库内置的 Cordis 启动器。这个相对路径基于当前工作目录计算。

假设你当前位于：

```
deepseek-harness/tmp/cordis-tutorial/
```

那么路径会解析为：

```
deepseek-harness/vendor/cordis/bin.js
```

启动器大致会执行这些操作：

```
创建 Cordis 根 Context
        ↓
加载 Cordis Loader
        ↓
读取当前目录的 ./cordis.yml
        ↓
解析其中的插件条目
        ↓
加载并执行插件的 apply(ctx)
        ↓
根据 inject 处理插件依赖关系
```

例如当前目录有：

```
# cordis.yml
- name: './hello.ts'
```

以及：

```
// hello.ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  console.log('Hello from Cordis!')
}
```

执行命令后，Cordis Loader 会发现 `./hello.ts`，然后调用：

```
apply(ctx)
```

输出：

```
Hello from Cordis!
```

之所以使用：

```
node --import tsx ...
```

而不是直接：

```
node ../../vendor/cordis/bin.js
```

是因为 Cordis 启动器本身虽然是 JavaScript，但 `cordis.yml` 很可能引用 TypeScript 插件：

```
- name: './hello.ts'
```

没有 `tsx`，Node 默认不能直接加载 `.ts` 文件。

还要注意，这条命令依赖当前目录：Cordis 会从当前工作目录读取 `./cordis.yml`。如果在仓库根目录执行，`../../vendor/cordis/bin.js` 的相对路径也会指向错误位置。若从仓库根目录启动同一个示例，应改成类似：

```
node --import tsx ./vendor/cordis/bin.js
```

但此时它会尝试读取仓库根目录下的 `cordis.yml`，而不是教程目录中的文件。



## Q11QQQQQQQQ

Agent Loop（智能体循环）是驱动 Agent 持续工作的核心控制程序。它不是大模型本身，而是负责反复执行“准备上下文 → 请求模型 → 执行工具 → 把结果交回模型”，直到任务结束。

可以把它理解成 Agent 的“发动机”。

## 基本循环

```
接收用户消息
    ↓
组装系统提示词、历史消息、工具定义
    ↓
调用大模型
    ↓
模型是否要求调用工具？
    ├─ 否 → 返回最终回答，结束
    └─ 是 → 执行工具
              ↓
          记录工具结果
              ↓
          再次调用模型
```

用伪代码表示：

```
async function agentLoop(userMessage: Message) {
  session.append(userMessage)

  while (true) {
    const messages = session.deriveMessages()
    const tools = toolRegistry.schemas()

    const response = await llm.generate({
      messages,
      tools,
    })

    session.append(response)

    if (response.toolCalls.length === 0) {
      return response
    }

    for (const call of response.toolCalls) {
      const result = await toolRegistry.execute(call)
      session.append(result)
    }
  }
}
```

真实项目里的实现复杂得多，还要处理流式输出、取消、审批、重试、并行工具和持久化。

## Turn 和 Step

理解 Agent Loop 最重要的是区分 Turn 和 Step。

### Turn

Turn 是一次完整的用户交互周期。

例如用户说：

```
帮我检查项目为什么无法构建
```

从收到这条消息到 Agent 给出最终答案，整体算一个 Turn。

### Step

Step 是 Turn 内部的一次模型请求，以及这次请求触发的工具调用。

例如：

```
Turn 1
├─ Step 1：模型决定读取 package.json
├─ Step 2：模型根据文件内容决定运行构建命令
├─ Step 3：模型分析错误并读取相关源码
└─ Step 4：模型给出最终答案
```

所以一个 Turn 通常包含多个 Step：

```
一个 Turn = 0 到多个 Step
一个 Step = 一次模型请求 + 该请求产生的工具调用
```

## 在 DeepSeek Harness 中的执行流程

当前项目的默认实现是 `ReactLoopAgent`，主体位于 [agent.ts (line 70)](E:/code/agent/deepseek-harness/packages/core/agent-loop/src/agent.ts:70)。

它大致按照以下顺序工作：

```
1. 从 Inbox 领取消息
2. 写入 turn/start
3. 组装 System Prompt 和工具 Schema
4. 执行 agent/pre-step 拦截管线
5. 写入 step/start
6. 把用户消息写入 Session
7. 从 Session 日志重新推导模型历史
8. 执行 agent/request，确定模型配置
9. 调用 ctx.llm 获取流式输出
10. 写入 assistant/message
11. 如果包含工具调用，交给 ctx.tools 执行
12. 写入 tool/call 和 tool/result
13. 必要时开始下一个 Step
14. 写入 step/end 和 turn/end
```

Turn 的控制逻辑在 [agent.ts (line 258)](E:/code/agent/deepseek-harness/packages/core/agent-loop/src/agent.ts:258)，模型与工具循环在 [agent.ts (line 344)](E:/code/agent/deepseek-harness/packages/core/agent-loop/src/agent.ts:344)。

## 为什么需要 Agent Loop

大模型自身只能完成一次输入到输出的推理：

```
输入消息 → 模型 → 输出内容
```

它不会自己真正读取文件、执行命令或保存状态。Agent Loop 把模型接入外部世界：

```
大模型负责决定“做什么”
Agent Loop 负责协调“怎么执行”
工具负责真正执行操作
Session 负责记录发生了什么
```

例如模型输出：

```
{
  "name": "read_file",
  "arguments": {
    "path": "package.json"
  }
}
```

Agent Loop 会：

1. 识别这是工具调用；
2. 交给 Tool Runtime；
3. 等待文件读取完成；
4. 把结果写入 Session；
5. 再调用模型；
6. 让模型基于文件内容继续推理。

## 输入的三种方式

Harness 的 Agent Loop 支持三种典型输入：

- `followup()`：开始下一个普通 Turn；
- `steer()`：在当前工作结束前，尽快影响下一个 Step；
- `inject()`：给下次模型请求添加上下文，但不主动唤醒 Agent。

例如：

```
agent.followup(userMessage)
agent.steer(correctionMessage)
agent.inject(workspaceContext)
```

它们最终进入 Agent 的 Inbox，由 Agent Loop 在合适的 Step 边界领取。

## Agent Loop 还负责什么

除了基本循环，它通常还承担：

- 流式输出管理；
- 工具并行和排他调度；
- 用户取消；
- 模型失败重试；
- 上下文压缩；
- 工具审批与权限检查；
- Turn/Step 生命周期事件；
- 崩溃恢复；
- Agent 空闲与运行状态切换；
- 子 Agent 和后台任务协调。

一句话总结：

> Agent Loop 是连接“用户输入、大模型推理、工具执行和持久化状态”的循环控制器；没有它，大模型只是一次性文本生成器，有了它才成为能够连续行动的 Agent。