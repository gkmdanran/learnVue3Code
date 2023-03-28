import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export class ReactiveEffect<T = any> {
  //表示ReactiveEffect实例是否还应该参与正常的依赖收集活动
  active = true
  deps: Dep[] = []
  //上一个处于活动中的ReactiveEffect实例
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  //是否是computed的effect
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  //允许递归调用
  allowRecurse?: boolean
  /**
   * @internal
   */
  private deferStop?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    //active为false直接返回
    if (!this.active) {
      return this.fn()
    }
    //parent存放
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      //实例上的parent存放上一个活跃的effect
      this.parent = activeEffect
      //当时这个effect实例成为activeEffect
      activeEffect = this
      shouldTrack = true

      trackOpBit = 1 << ++effectTrackDepth

      if (effectTrackDepth <= maxMarkerBits) {
        initDepMarkers(this)
      } else {
        //断开副作用函数与响应式数据之间的联系，避免有些数据不在使用了，但联系依然记录着
        cleanupEffect(this)
      }
      //执行run最终执行的就是fn函数
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        finalizeDepMarkers(this)
      }

      trackOpBit = 1 << --effectTrackDepth

      //执行完以后，activeEffect回到之前的effect
      activeEffect = this.parent
      shouldTrack = lastShouldTrack
      this.parent = undefined

      if (this.deferStop) {
        //执行完之后在执行stop
        this.stop()
      }
    }
  }

  stop() {
    // stopped while running itself - defer the cleanup
    if (activeEffect === this) {
      //如果当前活跃的effect就是本身，则先做标记，一会再调用stop
      this.deferStop = true
    } else if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        //调用onStop回调
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  //如果fn就是effect函数，那就取effect函数上的fn。  effect(effect(()=>{console.log(1)}))
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const _effect = new ReactiveEffect(fn)
  //将options合并到_effect对象中
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    //effect函数最终执行run方法
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  //将effect实例存在runner上并返回
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (shouldTrack && activeEffect) {
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined

    //dep和effect建立关联
    trackEffects(dep, eventInfo)
  }
}

export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    //dep中添加effect函数
    dep.add(activeEffect!)
    //effect函数上设置一个deps属性用来保存与dep的关联
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        extend(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo!
        )
      )
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    //set或map调用clear方法时应当触发它的所有响应
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    //修改数组的length属性时 arr.length=0
    const newLength = Number(newValue)
    depsMap.forEach((dep, key) => {
      //索引>=newLength的元素会收到影响，因为会被删除，所以会触发响应
      if (key === 'length' || key >= newLength) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      //元素添加操作
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          //对象的情况，需要触发for...in...循环，因此需要将ITERATE_KEY对应的dep进行添加
          //set或map时，迭代器方法，size，forEach都需要触发
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            //map的迭代器方法keys()涉及到key，所以还需要触发这个
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          //数组情况，数组长度改变需要触发length对应的deps
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      //元素删除操作
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          //对象的情况，需要触发for...in...循环，因此需要将ITERATE_KEY对应的dep进行添加
          //set或map时，迭代器方法，size，forEach都需要触发
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            //map的迭代器方法keys()涉及到key，所以还需要触发这个
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        //delete后数组长度不变
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          //map时，迭代器方法，size，forEach都需要触发
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  const effects = isArray(dep) ? dep : [...dep]
  for (const effect of effects) {
    if (effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
  for (const effect of effects) {
    if (!effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
}

function triggerEffect(
  effect: ReactiveEffect,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // 如果 trigger 触发执行的副作用函数与当前正在执行的副作用函数相同，则不触发执行，防止effect(()=>obj.foo++)既读取值又设置值造成递归。
  if (effect !== activeEffect || effect.allowRecurse) {
    if (__DEV__ && effect.onTrigger) {
      effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
    }
    if (effect.scheduler) {
      //有调度函数就调用调度函数
      effect.scheduler()
    } else {
      effect.run()
    }
  }
}

export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
