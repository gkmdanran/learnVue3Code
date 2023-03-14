import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      //这里使用this.length，this是代理对象，所以'length'也会被收集
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      //因为这些操作都会修改数组的length，所以需要维护一个全局变量 shouldTrack 来避免和length建立联系
      //shouldTrack=false
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      //shouldTrack=true
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function hasOwnProperty(this: object, key: string) {
  //转换为原始对象
  const obj = toRaw(this)
  //因为delete可能会影响hasOwnProperty结果，所以需要track收集依赖
  track(obj, TrackOpTypes.HAS, key)
  //调用原始对象的hasOwnProperty
  return obj.hasOwnProperty(key)
}

function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (
      //代理对象通过raw来获取原始对象
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)

    if (!isReadonly) {
      //readonly=false,才会重写数组方法
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        //数组的处理，通过arrayInstrumentations重写数组方法
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      if (key === 'hasOwnProperty') {
        //hasOwnProperty特殊处理
        return hasOwnProperty
      }
    }

    const res = Reflect.get(target, key, receiver)

    //for...of循环过程中，会读取数组的 Symbol.iterator 属性，属性是symbol类型，不需要收集关于这个属性的依赖，因此直接返回值
    //对于一些特殊的key：__proto__ , __v_isRef , __isVue 也是直接返回值
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    if (!isReadonly) {
      //只有readonly=false时才会收集依赖，因为readonly不能修改值不会触发响应，所以也就无需收集
      track(target, TrackOpTypes.GET, key)
    }

    //第一层已经收集完毕，shallow为true时不需要再对更深层级收集依赖了，直接返回值
    if (shallow) {
      return res
    }

    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    //到这一步shallow一定是false，如果是对象就递归处理，实现深层响应式
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    //获取旧值
    let oldValue = (target as any)[key]
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    if (!shallow) {
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    //判断是新增值还是设置值
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 子对象的原型是父对象，原型式继承。
    // 子对象设置值时如果属性不存在，会从原型上去查找，而作为原型的父对象会再次触发set，需要通过这个判断来规避第二次set
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  //删除成功并且删除的属性原来就在对象上
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

//拦截in操作符 if(key in obj){}
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  //对象和数组都能通过for...in...循环，如果是数组，就收集length相关的依赖，对象则通过symbol创建一共key来收集依赖
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

//通过reactive创建的COMMON proxy对象的handlers
export const mutableHandlers: ProxyHandler<object> = {
  //读取值时拦截
  get,
  //设置值时拦截
  set,
  //拦截delete操作符 delete obj.bar
  deleteProperty,
  //拦截in操作符 if(key in obj){}
  has,
  //拦截for...in...
  ownKeys
}

//通过readonly创建的COMMON proxy对象的handlers
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  //不可重新设置属性值
  set(target, key) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  //不可删除属性
  deleteProperty(target, key) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

//通过shallowReactive创建的COMMON proxy对象的handlers
export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
//通过shallowReadonly创建的COMMON proxy对象的handlers
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
