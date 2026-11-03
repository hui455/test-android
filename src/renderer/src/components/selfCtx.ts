import { createContext } from 'react'

/** 给项目标签和“⋯”菜单用：dev 表示填了自测令牌，on 表示这个项目打开了开发自测 */
export const SelfCtx = createContext<{ dev: boolean; on: boolean; count: number; toggle: () => void }>({ dev: false, on: false, count: 0, toggle: () => {} })
