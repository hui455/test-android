import { describe, expect, it } from 'vitest'
import { parseDevices, parseForeground } from '../src/main/adb'

describe('adb 输出解析', () => {
  it('解析 adb devices -l', () => {
    const out = `List of devices attached
9c3f1a2e               device usb:1-1 product:houji model:23127PN0CC device:houji transport_id:1
emulator-5554          unauthorized transport_id:2
192.168.1.20:5555      device product:x model:Pixel_7 device:panther transport_id:3
`
    expect(parseDevices(out)).toEqual([
      { serial: '9c3f1a2e', state: 'device', model: '23127PN0CC', transport: 'usb' },
      { serial: 'emulator-5554', state: 'unauthorized', model: 'emulator-5554', transport: 'usb' },
      { serial: '192.168.1.20:5555', state: 'device', model: 'Pixel 7', transport: 'tcp' }
    ])
  })

  it('解析前台 Activity', () => {
    expect(parseForeground('  mCurrentFocus=Window{a1b2 u0 com.demo.mall/com.demo.mall.OrderActivity}')).toBe('com.demo.mall/com.demo.mall.OrderActivity')
    expect(parseForeground('nothing')).toBe('')
  })
})
