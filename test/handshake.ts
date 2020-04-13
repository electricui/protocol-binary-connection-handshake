import * as sinon from 'sinon'

import {
  DEVICE_EVENTS,
  Device,
  DeviceManager,
  Message,
  MessageQueueImmediate,
  MessageRouterTestCallback,
} from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'

import BinaryConnectionHandshake from '../src/handshake'
import { EventEmitter } from 'events'
import FakeTimers from '@sinonjs/fake-timers'
import { Subscription } from 'rxjs'

const delay = (delay: number) => {
  return new Promise((res, rej) => {
    setTimeout(res, delay)
    clock.tickAsync(delay)
  })
}

const defaultState = {
  life_and_the_universe: 42,
  foo: 'bar',
}

type StateShape = {
  [key: string]: any
}

type MockDeviceOptions<S> = {
  sendHeartbeats: boolean
  mutableSwitches: {
    replyForMessageID: { [K in keyof S]?: boolean }
    replyWithMessageIDList: boolean
    replyWithNumberOfMessageIDs: boolean
  }
}

function defaultOptions<S extends StateShape>(state: S): MockDeviceOptions<S> {
  const opt: MockDeviceOptions<S> = {
    sendHeartbeats: false,
    mutableSwitches: {
      replyForMessageID: {},
      replyWithMessageIDList: true,
      replyWithNumberOfMessageIDs: true,
    },
  }

  for (const stateKey of Object.keys(state)) {
    opt.mutableSwitches.replyForMessageID[stateKey as keyof typeof state] = true
  }

  return opt
}

function cleanup(
  handshake: BinaryConnectionHandshake,
  device: Device,
  emitter: EventEmitter,
) {
  handshake.detachHandlers()
  device.removeAllListeners()
  emitter.removeAllListeners()
}

const enum MOCK_DEVICE_EVENTS {
  SENT_HEARTBEAT = 'sent-heartbeat',
  SENT_STATE = 'sent-state',
  RECEIVED_QUERY = 'received-query', // messageID
  RECEIVED_REQUEST_LIST = 'received-request-list',
  RECEIVED_REQUEST_OBJECTS = 'received-request-objects',
  TICK = 'tick',
}

// Statically type our mock EventEmitter
export interface DeviceEmitter extends EventEmitter {
  // Event attachment
  on(event: MOCK_DEVICE_EVENTS.SENT_HEARTBEAT, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.SENT_STATE, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_QUERY, listener: (messageID: string) => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.TICK, listener: () => void): this // prettier-ignore

  // Event attachment
  once(event: MOCK_DEVICE_EVENTS.SENT_HEARTBEAT, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.SENT_STATE, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_QUERY, listener: (messageID: string) => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.TICK, listener: () => void): this // prettier-ignore

  // Event detatchment
  removeListener(event: MOCK_DEVICE_EVENTS.SENT_HEARTBEAT, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.SENT_STATE, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_QUERY, listener: (messageID: string) => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.TICK, listener: () => void): this // prettier-ignore
}

function buildCompliantDevice<S extends StateShape>(
  state: S,
  options: MockDeviceOptions<S>,
) {
  const deviceManager = new DeviceManager()
  const device = new Device('mock', deviceManager)
  const emitter: DeviceEmitter = new EventEmitter()

  const underlyingDevice = async (message: Message) => {
    setImmediate(() => {
      // Send heartbeat replies before every response
      if (options.sendHeartbeats) {
        const heartbeatMessage = new Message(
          MESSAGEIDS.HEARTBEAT,
          Math.floor(Math.random() * 100),
        )
        heartbeatMessage.metadata.internal = true
        device.receive(heartbeatMessage)
        emitter.emit(MOCK_DEVICE_EVENTS.SENT_HEARTBEAT)
      }

      if (!message.metadata.internal && message.metadata.query) {
        emitter.emit(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, message.messageID)

        // if something gets queried check if it exists
        if (Object.keys(state).includes(message.messageID)) {
          // Reply with the state if our mutable switch is still true
          if (options.mutableSwitches.replyForMessageID[message.messageID]) {
            const reply = new Message(
              message.messageID,
              state[message.messageID],
            )
            device.receive(reply)
            emitter.emit(
              MOCK_DEVICE_EVENTS.SENT_STATE,
              message.messageID,
              message.payload,
            )
          }

          return
        }
      } else if (message.metadata.type === TYPES.CALLBACK) {
        switch (message.messageID) {
          case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST:
            emitter.emit(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST)

            const listMessage = new Message(
              MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
              Object.keys(state),
            )
            listMessage.metadata.internal = true

            if (options.mutableSwitches.replyWithMessageIDList) {
              device.receive(listMessage)
            }

            const countMessage = new Message(
              MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
              Object.keys(state).length,
            )
            countMessage.metadata.internal = true

            if (options.mutableSwitches.replyWithNumberOfMessageIDs) {
              device.receive(countMessage)
            }

            break
          case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS:
            emitter.emit(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS)

            for (const messageID of Object.keys(state)) {
              // Check if
              if (options.mutableSwitches.replyForMessageID[messageID]) {
                const def = new Message(messageID, state[messageID])
                device.receive(def)
              }
            }
            break
          default:
            break
        }
      }
    })
  }

  // Build our message queue and our router to mock the logic on the device.
  new MessageQueueImmediate(device)
  new MessageRouterTestCallback(device, underlyingDevice)

  return { device, emitter }
}

function monitorDeviceState<S extends StateShape = typeof defaultState>(
  device: Device,
): S {
  const receivedState: StateShape = {}

  device.on(DEVICE_EVENTS.DATA, (message: Message) => {
    if (!message.metadata.internal) {
      receivedState[message.messageID] = message.payload
    }
  })

  return receivedState as S
}

function spyHandshakeProgress(handshake: BinaryConnectionHandshake) {
  const progressSpy = jest.fn()
  const errorSpy = jest.fn()
  let subscription: Subscription

  const success = new Promise((resolve, reject) => {
    // Once the current stack frame has collapsed down, subscribe
    process.nextTick(() => {
      let sub = handshake.observable.subscribe(
        progressSpy,
        (...args) => {
          errorSpy(...args)
          reject(...args)
        },
        resolve,
      )
      subscription = sub
    })
  })

  // Cancellation needs to happen at the end of the stack frame
  const cancel = () => {
    process.nextTick(() => {
      if (!subscription.closed) {
        subscription.unsubscribe()
      } else {
        console.log('Was already unsubscribed')
      }
    })
  }

  return {
    progressSpy,
    errorSpy,
    success,
    cancel,
  }
}

let clock: FakeTimers.InstalledClock

describe('Connection Handshake', () => {
  beforeEach(() => {
    clock = FakeTimers.install({
      shouldAdvanceTime: true,
      advanceTimeDelta: 20,
    })
  })

  afterEach(() => {
    clock.uninstall()
  })

  test('replies with the correct identifier', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(defaultState, options)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    expect(connectionHandshake.getIdentifier()).toBe(
      'electricui-binary-protocol-handshake',
    )

    cleanup(connectionHandshake, device, emitter)
  })

  test('performs a handshake through the happy path', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(defaultState, options)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })

  test("doesn't care if heartbeat messages are sent during the handshake", async () => {
    const state = defaultState
    const options = defaultOptions(state)
    options.sendHeartbeats = true

    const { device, emitter } = buildCompliantDevice(defaultState, options)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    const uiState = monitorDeviceState(device)

    const { success } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })

  test('cancels correctly after receiving a request for a list', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    options.sendHeartbeats = true

    // This will execute syncronously unless we break it up
    options.mutableSwitches.replyWithNumberOfMessageIDs = false

    const { device, emitter } = buildCompliantDevice(defaultState, options)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    const uiState = monitorDeviceState(device)

    const { success, cancel } = spyHandshakeProgress(connectionHandshake)

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, () => {
      cancel()
      clock.nextAsync()
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      throw new Error(
        'Received a request for objects when we should have cancelled',
      )
    })

    let finished = false

    success.then(() => {
      finished = true
    })

    await delay(4_000)

    expect(finished).toBe(false)

    expect.assertions(1)
    cleanup(connectionHandshake, device, emitter)
  })

  test('retries a full request of messageIDs when nothing has been received', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(defaultState, options)

    // Have one retry
    options.mutableSwitches.replyWithMessageIDList = false
    options.mutableSwitches.replyWithNumberOfMessageIDs = false
    let replyRetries = 0

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, () => {
      if (replyRetries > 0) {
        options.mutableSwitches.replyWithMessageIDList = true
        options.mutableSwitches.replyWithNumberOfMessageIDs = true
      }
      replyRetries++
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    // Our first subscription fires the first event, but we will ignore it, so skip to the timeout
    clock.tickAsync(1100)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })
})
