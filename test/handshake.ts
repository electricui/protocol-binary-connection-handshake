/* eslint-disable no-case-declarations */
import * as sinon from 'sinon'

import BinaryConnectionHandshake, {
  PROGRESS_KEYS,
  ProgressMeta,
} from '../src/handshake'
import {
  DEVICE_EVENTS,
  Device,
  DeviceManager,
  Message,
  MessageQueueImmediate,
  MessageRouterTestCallback,
} from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'

import { EventEmitter } from 'events'
import FakeTimers from '@sinonjs/fake-timers'
import { Subscription } from 'rxjs'

const delay = (delay: number) => {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, delay)
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
  modulusMessageIDListReplies: number
  modulusMessageIDListReplyOffset: number
  heartbeatMessageID: string
  requestObjectsMessageID: string
  requestListMessageID: string
  amountMessageID: string
  listMessageID: string
  shouldThrowDuringQuery: boolean
  shouldThrowDuringCallback: boolean
}

function defaultOptions<S extends StateShape>(state: S): MockDeviceOptions<S> {
  const opt: MockDeviceOptions<S> = {
    sendHeartbeats: false,
    mutableSwitches: {
      replyForMessageID: {},
      replyWithMessageIDList: true,
      replyWithNumberOfMessageIDs: true,
    },

    modulusMessageIDListReplies: 1, // send every messageID on list
    modulusMessageIDListReplyOffset: 0, // allows us to send the 'other' messageIDs if we mod the list

    heartbeatMessageID: MESSAGEIDS.HEARTBEAT,
    requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
    listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
    amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
    requestObjectsMessageID:
      MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,

    shouldThrowDuringQuery: false,
    shouldThrowDuringCallback: false,
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
  RECEIVED_CALLBACK = 'received-callback',
}

// Statically type our mock EventEmitter
export interface DeviceEmitter extends EventEmitter {
  // Event attachment
  on(event: MOCK_DEVICE_EVENTS.SENT_HEARTBEAT, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.SENT_STATE, listener: (messageID: string, payload: any) => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_QUERY, listener: (messageID: string) => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.TICK, listener: () => void): this // prettier-ignore
  on(event: MOCK_DEVICE_EVENTS.RECEIVED_CALLBACK, listener: () => void): this // prettier-ignore

  // Event attachment
  once(event: MOCK_DEVICE_EVENTS.SENT_HEARTBEAT, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.SENT_STATE, listener: (messageID: string, payload: any) => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_QUERY, listener: (messageID: string) => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.TICK, listener: () => void): this // prettier-ignore
  once(event: MOCK_DEVICE_EVENTS.RECEIVED_CALLBACK, listener: () => void): this // prettier-ignore

  // Event detatchment
  removeListener(event: MOCK_DEVICE_EVENTS.SENT_HEARTBEAT, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.SENT_STATE, listener: (messageID: string, payload: any) => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_QUERY, listener: (messageID: string) => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.TICK, listener: () => void): this // prettier-ignore
  removeListener(event: MOCK_DEVICE_EVENTS.RECEIVED_CALLBACK, listener: () => void): this // prettier-ignore
}

function buildCompliantDevice<S extends StateShape>(
  state: S,
  options: MockDeviceOptions<S>,
) {
  const deviceManager = new DeviceManager()
  const device = new Device('mock', deviceManager)
  const emitter: DeviceEmitter = new EventEmitter()

  const underlyingDevice = async (message: Message) => {
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        // Send heartbeat replies before every response
        if (options.sendHeartbeats) {
          const heartbeatMessage = new Message(
            options.heartbeatMessageID,
            Math.floor(Math.random() * 100),
          )
          heartbeatMessage.metadata.internal = true
          device.receive(heartbeatMessage)
          emitter.emit(MOCK_DEVICE_EVENTS.SENT_HEARTBEAT)
        }

        if (!message.metadata.internal && message.metadata.query) {
          emitter.emit(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, message.messageID)

          if (!Object.keys(state).includes(message.messageID)) {
            console.log('State does not contain a messageID', message.messageID)
          }

          if (options.shouldThrowDuringQuery) {
            reject(new Error('Throwing during a query'))
            return
          }

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
                state[message.messageID],
              )
            }

            return
          }
        } else if (message.metadata.type === TYPES.CALLBACK) {
          emitter.emit(MOCK_DEVICE_EVENTS.RECEIVED_CALLBACK)

          if (options.shouldThrowDuringCallback) {
            reject(new Error('Throwing during a callback'))
            return
          }

          switch (message.messageID) {
            case options.requestListMessageID:
              emitter.emit(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST)

              const listMessage = new Message(
                options.listMessageID,
                // Only send those
                Object.keys(state).filter(
                  (msgId, index) =>
                    (index + options.modulusMessageIDListReplyOffset) %
                      options.modulusMessageIDListReplies ===
                    0,
                ),
              )
              listMessage.metadata.internal = true

              if (options.mutableSwitches.replyWithMessageIDList) {
                device.receive(listMessage)
              }

              const countMessage = new Message(
                options.amountMessageID,
                Object.keys(state).length,
              )
              countMessage.metadata.internal = true

              if (options.mutableSwitches.replyWithNumberOfMessageIDs) {
                device.receive(countMessage)
              }

              break
            case options.requestObjectsMessageID:
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

        // Resolve the promse if we didn't exit early
        resolve()
      })

      // Allow for a time fast-forward once the promise is instantiated
      emitter.emit(MOCK_DEVICE_EVENTS.TICK)
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

  device.on(DEVICE_EVENTS.DATA, (device: Device, message: Message) => {
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
      const sub = handshake.observable.subscribe(
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

  clock.tickAsync(1100)

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
    const { device, emitter } = buildCompliantDevice(state, options)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    expect(connectionHandshake.getIdentifier()).toBe(
      'electricui-binary-protocol-handshake',
    )

    cleanup(connectionHandshake, device, emitter)
  })

  test('throws when partially setup for a custom handshake', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    options.heartbeatMessageID = 'heartbeat'
    options.requestObjectsMessageID = 'a'
    options.requestListMessageID = 'b'
    options.amountMessageID = 'c'

    let connectionHandshake: BinaryConnectionHandshake

    expect(() => {
      connectionHandshake = new BinaryConnectionHandshake({
        device: device,
        preset: 'custom',
        requestObjectsMessageID: options.requestObjectsMessageID,
        requestListMessageID: options.requestListMessageID,
        amountMessageID: options.amountMessageID,
        // listMessageID: options.listMessageID, // ignore one to throw
      })
    }).toThrow('Need to specify all messageIDs')

    // cleanup(connectionHandshake, device, emitter)
  })

  test('functions with custom messageIDs on both ends', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    options.heartbeatMessageID = 'heartbeat'
    options.requestObjectsMessageID = 'a'
    options.requestListMessageID = 'b'
    options.amountMessageID = 'c'
    options.listMessageID = 'd'

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'custom',
      requestObjectsMessageID: options.requestObjectsMessageID,
      requestListMessageID: options.requestListMessageID,
      amountMessageID: options.amountMessageID,
      listMessageID: options.listMessageID,
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })

  test('throws when using a duplicate messageID', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    options.heartbeatMessageID = 'heartbeat'
    options.requestObjectsMessageID = 'a'
    options.requestListMessageID = 'b'
    options.amountMessageID = options.requestListMessageID // duplicate messageID

    let connectionHandshake: BinaryConnectionHandshake

    expect(() => {
      connectionHandshake = new BinaryConnectionHandshake({
        device: device,
        preset: 'custom',
        requestObjectsMessageID: options.requestObjectsMessageID,
        requestListMessageID: options.requestListMessageID,
        amountMessageID: options.amountMessageID,
        listMessageID: options.listMessageID, // ignore one to throw
      })
    }).toThrow('Duplicate messageID used')

    // cleanup(connectionHandshake, device, emitter)
  })

  test('performs a handshake through the happy path', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

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

    const { device, emitter } = buildCompliantDevice(state, options)

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

    const { device, emitter } = buildCompliantDevice(state, options)

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

    // eslint-disable-next-line promise/catch-or-return
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
    const { device, emitter } = buildCompliantDevice(state, options)

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

    await success

    expect(uiState).toEqual(state)

    expect.assertions(1)
    cleanup(connectionHandshake, device, emitter)
  })

  test('retries a bulk request of messageIDs when nothing has been received', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send _any_ objects the first time
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }
    let replyRetries = 0

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      if (replyRetries > 0) {
        for (const messageID of Object.keys(state)) {
          options.mutableSwitches.replyForMessageID[
            messageID as keyof typeof state
          ] = true
        }
      }
      replyRetries++
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    expect.assertions(1)
    cleanup(connectionHandshake, device, emitter)
  })

  test('fails a bulk request of messageIDs when nothing has been received more times than retries allow', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send _any_ objects the first time
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    // Setup our error catcher
    success.catch(() => {
      // should have timed out

      expect(uiState).toEqual({})
    })

    // Skip forward into the future when all the timeouts have occurred
    await delay(10_000)

    expect.assertions(1)
    cleanup(connectionHandshake, device, emitter)
  })

  // This doesn't provide any additional branch coverage but it's good to know it fails
  test('fails a handshake if the device never replies to anything', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send any objects
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }
    options.mutableSwitches.replyWithMessageIDList = false
    options.mutableSwitches.replyWithNumberOfMessageIDs = false

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    // Setup our error catcher
    success.catch(() => {
      // should have timed out

      expect(uiState).toEqual({})
    })

    // Skip forward into the future when all the timeouts have occurred
    await delay(10_000)

    expect.assertions(1)
    cleanup(connectionHandshake, device, emitter)
  })

  test("switches to individual request mode and succeeds on a partial bulk request failure when there's only one messageID left", async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send any objects yet
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      // On object request, allow foo to be sent, but don't sent the others
      options.mutableSwitches.replyForMessageID.foo = true

      // Add to our assertion count
      expect(true).toBe(true)
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, messageID => {
      // When MessageIDs are directly queried, allow them to be sent
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = true
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await delay(10_000)

    await success

    expect(uiState).toEqual(state)

    expect.assertions(2)
    cleanup(connectionHandshake, device, emitter)
  })

  test('switches to individual request mode and succeeds on a partial bulk request failure with multiple messageIDs', async () => {
    const state = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send any objects yet
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      // On object request, allow 'a' to be sent, but don't sent the others
      options.mutableSwitches.replyForMessageID.a = true

      // Add to our assertion count
      expect(true).toBe(true)
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, messageID => {
      // When MessageIDs are directly queried, allow them to be sent
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = true
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await delay(10_000)

    await success

    expect(uiState).toEqual(state)

    expect.assertions(2)
    cleanup(connectionHandshake, device, emitter)
  })

  test("receiving a runtime message during the last individual request stage doesn't fail", async () => {
    const state = {
      a: 1,
      b: 2,
      c: 3,
      // d: 4 // a runtime message
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send any objects yet
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      // On object request, allow 'a' to be sent, but don't sent the others
      options.mutableSwitches.replyForMessageID.a = true

      // Add to our assertion count
      expect(true).toBe(true)
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, messageID => {
      // When MessageIDs are directly queried, allow them to be sent
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = true

      if (messageID === 'c') {
        process.nextTick(() => {
          device.receive(new Message('d', 4))
        })
      }
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await delay(10_000)

    await success

    expect(uiState).toEqual(
      Object.assign({
        ...state,
        d: 4,
      }),
    )

    expect.assertions(2)
    cleanup(connectionHandshake, device, emitter)
  })

  test("receiving messages multiple times doesn't fail", async () => {
    const state = {
      a: 1,
      b: 2,
      c: 3,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send any objects yet
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      // On object request, allow 'a' to be sent, but don't sent the others
      options.mutableSwitches.replyForMessageID.a = true

      // Add to our assertion count
      expect(true).toBe(true)
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, messageID => {
      // When MessageIDs are directly queried, allow them to be sent
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = true

      if (messageID === 'b') {
        device.receive(new Message('b', 2))
      }
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await delay(10_000)

    await success

    expect(uiState).toEqual(state)

    expect.assertions(2)
    cleanup(connectionHandshake, device, emitter)
  })

  test('receiving undefined payloads are handled in bulk request mode', async () => {
    const state = {
      a: 1,
      b: undefined,
      c: 3,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

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

  test('receiving undefined payloads are handled in individual request mode', async () => {
    const state = {
      a: 1,
      b: undefined,
      c: 3,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send any objects yet
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      // On object request, allow 'a' to be sent, but don't sent the others
      options.mutableSwitches.replyForMessageID.a = true

      // Add to our assertion count
      expect(true).toBe(true)
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, messageID => {
      // When MessageIDs are directly queried, allow them to be sent
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = true
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await delay(10_000)

    await success

    expect(uiState).toEqual(state)

    expect.assertions(2)
    cleanup(connectionHandshake, device, emitter)
  })

  test('recovers when a callback throws', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    options.shouldThrowDuringCallback = true

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    let throws = 0

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_CALLBACK, () => {
      // Allow for one throw
      if (throws > 0) {
        options.shouldThrowDuringCallback = false
      }

      throws++
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })

  test('recovers when a query throws', async () => {
    const state = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    options.shouldThrowDuringQuery = true

    // Don't send any objects yet
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_OBJECTS, () => {
      // On object request, allow 'a' to be sent, but don't sent the others
      options.mutableSwitches.replyForMessageID.a = true

      // Add to our assertion count
      expect(true).toBe(true)
    })

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_QUERY, messageID => {
      // Allow for one throw
      if (throws > 0) {
        options.shouldThrowDuringQuery = false
      }

      throws++

      // When MessageIDs are directly queried, allow them to be sent
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = true
    })

    let throws = 0

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await delay(10_000)

    await success

    expect(uiState).toEqual(state)

    expect.assertions(2)
    cleanup(connectionHandshake, device, emitter)
  })

  test('fails a bulk request with a custom timeout', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    // Don't send _any_ objects the first time
    for (const messageID of Object.keys(state)) {
      options.mutableSwitches.replyForMessageID[
        messageID as keyof typeof state
      ] = false
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
      timeout: 10, // custom timeout of 10ms
    })

    emitter.on(MOCK_DEVICE_EVENTS.TICK, () => {
      clock.nextAsync()
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    // Setup our error catcher
    success.catch(() => {
      // should have timed out

      expect(uiState).toEqual({})
    })

    // Skip forward into the future when all the timeouts have occurred
    await delay(10_000)

    expect.assertions(1)
    cleanup(connectionHandshake, device, emitter)
  })

  test('handles receiving devloper messages outside of the request window', async () => {
    const state = {
      a: 1,
      b: 2,
      c: 3,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    emitter.once(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, () => {
      // Send developer packets before sending the list, outside of the request window
      device.receive(new Message('b', state.b))
      device.receive(new Message('c', state.c))
    })

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })

  test('allows for messageIDs to come in over multiple packets', async () => {
    const state = {
      a: 1,
      b: 1,
      c: 1,
      d: 1,
      e: 1,
      f: 1,
      g: 1,
      h: 1,
      i: 1,
      j: 1,
      k: 1,
    }
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    options.modulusMessageIDListReplies = 2 // send half the messages

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
    })

    const uiState = monitorDeviceState(device)

    emitter.on(MOCK_DEVICE_EVENTS.RECEIVED_REQUEST_LIST, () => {
      // every time we recieve a request, send the next 'half'
      options.modulusMessageIDListReplyOffset++
    })

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })

  test('allows custom progress messages', async () => {
    const state = defaultState
    const options = defaultOptions(state)
    const { device, emitter } = buildCompliantDevice(state, options)

    const progressText = (
      progressKey: PROGRESS_KEYS,
      meta: ProgressMeta = {},
    ): string | null => {
      return 'progress!'
    }

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      preset: 'default',
      progressText: progressText,
    })

    const uiState = monitorDeviceState(device)

    const { success, progressSpy } = spyHandshakeProgress(connectionHandshake)

    await success

    expect(uiState).toEqual(state)

    cleanup(connectionHandshake, device, emitter)
  })
})
