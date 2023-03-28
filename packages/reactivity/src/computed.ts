import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

export class ComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean = false

  public _dirty = true
  public _cacheable: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean,
    isSSR: boolean
  ) {
    //创建一个关于computed的effect，第二个参数是scheduler
    this.effect = new ReactiveEffect(getter, () => {
      //当依赖改变的时候，会重新执行effect，因此会执行scheduler，之前_dirty置为false
      if (!this._dirty) {
        //依赖改变了需要重新计算了_dirty置为true，下次再读取值就会重新计算了
        this._dirty = true
        //重新建立响应关系
        triggerRefValue(this)
      }
    })
    this.effect.computed = this
    this.effect.active = this._cacheable = !isSSR
    //只读标记
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  //计算属性获取值
  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    //computed可能被readonly包裹，所以需要还原
    const self = toRaw(this)
    //建立响应关系
    trackRefValue(self)
    //_dirty初始值是true，所计算属性首次读取值时会进入这个条件
    if (self._dirty || !self._cacheable) {
      //将_dirty置为false，依赖不改变_dirty就是false，就不会重新计算
      self._dirty = false
      //调用computedEffect的run方法，实际就是调用getter计算得到值
      self._value = self.effect.run()!
    }
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  //只传了一个参数，并且是个函数，那这个函数就是getter
  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    //如果是对象，那么就分别取get和set
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  //只传了函数（getter）或者对象参数没有set属性，表示当前computed只读
  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
