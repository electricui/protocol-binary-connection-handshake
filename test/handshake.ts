import 'mocha'

import * as chai from 'chai'
import * as sinon from 'sinon'

import {
  Connection,
  ConnectionInterface,
  Device,
  DeviceManager,
  Message,
  MessageQueueImmediate,
  MessageRouterTestCallback,
} from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'

import BinaryConnectionHandshake from '../src/handshake'

const assert = chai.assert

const delay = (delay: number) => {
  return new Promise((res, rej) => {
    setTimeout(res, delay)
  })
}

describe('Connection Handshake', () => {
  it('performes a handshake through the happy path', async () => {
    const deviceManager = new DeviceManager()
    const device = new Device('mock', deviceManager)
    const connectionInterface = new ConnectionInterface()
    const connection = new Connection({ connectionInterface })

    const underlyingDevice = async (message: Message) => {
      setImmediate(() => {
        if (message.metadata.query) {
          // if something gets queried,
          device.receive(new Message(message.messageID, 0), connection)
        } else if (message.metadata.type === TYPES.CALLBACK) {
          switch (message.messageID) {
            case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST:
              const listMessage = new Message(
                MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
                ['abc', 'def'],
              )
              listMessage.metadata.internal = true

              const countMessage = new Message(
                MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
                2,
              )
              countMessage.metadata.internal = true

              device.receive(listMessage, connection)
              device.receive(countMessage, connection)

              break
            case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS:
              const abc = new Message('abc', 0)
              device.receive(abc, connection)

              const def = new Message('def', 0)
              device.receive(def, connection)
              break
            default:
              break
          }
        }
      })
    }

    new MessageQueueImmediate(device)
    new MessageRouterTestCallback(device, underlyingDevice)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
      requestObjectsMessageID:
        MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
      listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
      amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
    })

    const progressSpy = sinon.spy()
    const errorSpy = sinon.spy()
    const completeSpy = sinon.spy()

    let abc
    let def

    device.on('data', (message: Message) => {
      switch (message.messageID) {
        case 'abc':
          abc = message.payload
          break
        case 'def':
          def = message.payload
          break
        default:
          break
      }
    })

    const promise = new Promise((resolve, reject) => {
      connectionHandshake.observable.subscribe(progressSpy, errorSpy, resolve)
    })

    await promise

    assert.strictEqual(abc, 0)
    assert.strictEqual(def, 0)
  })

  it('performes a handshake with list retries and object retries', async () => {
    const deviceManager = new DeviceManager()
    const device = new Device('mock', deviceManager)
    const connectionInterface = new ConnectionInterface()
    const connection = new Connection({ connectionInterface })

    let listRequestNumber = 0
    let objectRequestNumber = 0

    // this is a mock device
    const underlyingDevice = async (message: Message) => {
      setImmediate(() => {
        if (message.metadata.query) {
          // if something gets queried,
          device.receive(new Message(message.messageID, 0), connection)
        } else if (message.metadata.type === TYPES.CALLBACK) {
          switch (message.messageID) {
            case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST:
              switch (listRequestNumber) {
                case 0:
                  // send nothing first time
                  break
                case 1:
                  // send half the messages second time
                  const listMessage1 = new Message(
                    MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
                    ['abc'],
                  )
                  listMessage1.metadata.internal = true

                  const countMessage1 = new Message(
                    MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
                    2,
                  )
                  countMessage1.metadata.internal = true

                  device.receive(listMessage1, connection)
                  device.receive(countMessage1, connection)
                  break

                default:
                  // send all messages the third time
                  const listMessage2 = new Message(
                    MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
                    ['abc', 'def'],
                  )
                  listMessage2.metadata.internal = true

                  const countMessage2 = new Message(
                    MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
                    2,
                  )
                  countMessage2.metadata.internal = true

                  device.receive(listMessage2, connection)
                  device.receive(countMessage2, connection)
                  break
              }

              listRequestNumber = listRequestNumber + 1
              break
            case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS:
              switch (objectRequestNumber) {
                case 0:
                  // send nothing the first time
                  break
                case 1:
                  // send half the messages first time
                  const abc1 = new Message('abc', 0)
                  device.receive(abc1, connection)
                  break

                default:
                  // send all the third time
                  const abc2 = new Message('abc', 0)
                  device.receive(abc2, connection)
                  const def = new Message('def', 0)
                  device.receive(def, connection)

                  break
              }

              objectRequestNumber = objectRequestNumber + 1
              break
            default:
              break
          }
        }
      })
    }

    new MessageQueueImmediate(device)
    new MessageRouterTestCallback(device, underlyingDevice)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
      requestObjectsMessageID:
        MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
      listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
      amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
    })

    const progressSpy = sinon.spy()
    const errorSpy = sinon.spy()
    const completeSpy = sinon.spy()

    let abc
    let def

    device.on('data', (message: Message) => {
      switch (message.messageID) {
        case 'abc':
          abc = message.payload
          break
        case 'def':
          def = message.payload
          break
        default:
          break
      }
    })

    const promise = new Promise(async (resolve, reject) => {
      connectionHandshake.observable.subscribe(progressSpy, errorSpy, resolve)
    })

    let time = 0
    connectionHandshake.getNow = () => time

    // loop 5s into the future and loop again
    for (let index = 0; index < 5; index++) {
      time += 5000
      connectionHandshake.loop(time)
      await delay(0)
    }

    await promise

    assert.strictEqual(abc, 0)
    assert.strictEqual(def, 0)
  })

  it('times out', async () => {
    const deviceManager = new DeviceManager()
    const device = new Device('mock', deviceManager)
    const connectionInterface = new ConnectionInterface()
    const connection = new Connection({ connectionInterface })

    const underlyingDevice = async (message: Message) => {
      // do nothing
    }

    new MessageQueueImmediate(device)
    new MessageRouterTestCallback(device, underlyingDevice)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
      requestObjectsMessageID:
        MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
      listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
      amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
    })

    const progressSpy = sinon.spy()
    const errorSpy = sinon.spy()
    const completeSpy = sinon.spy()

    const promise = new Promise((resolve, reject) => {
      connectionHandshake.observable.subscribe(
        progressSpy,
        resolve,
        completeSpy,
      )
    })

    let time = 0
    connectionHandshake.getNow = () => time

    // loop 10 seconds into the future enough times to max out the retries
    for (let index = 0; index < 10; index++) {
      time += 10000
      connectionHandshake.getNow = () => time
      connectionHandshake.loop(time)
    }

    const err = await promise

    assert.exists(err)
    assert.instanceOf(err, Error)
  })
  it('cancels everything when told to', async () => {
    const deviceManager = new DeviceManager()
    const device = new Device('mock', deviceManager)
    const connectionInterface = new ConnectionInterface()
    const connection = new Connection({ connectionInterface })

    let unsubscribeHandler = () => {
      console.error(
        "Something weird happened and the unsubscribeHandler didn't get attached",
      )
    }

    const underlyingDevice = async (message: Message) => {
      setImmediate(() => {
        if (message.metadata.query) {
          // if something gets queried,
          device.receive(new Message(message.messageID, 0), connection)
        } else if (message.metadata.type === TYPES.CALLBACK) {
          switch (message.messageID) {
            case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST:
              // Cancel, then send some data
              unsubscribeHandler()

              const listMessage = new Message(
                MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
                ['abc', 'def'],
              )
              listMessage.metadata.internal = true

              const countMessage = new Message(
                MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
                2,
              )
              countMessage.metadata.internal = true

              device.receive(listMessage, connection)
              device.receive(countMessage, connection)

              break
            case MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS:
              throw new Error('It should have cancelled itself by now')
              break
            default:
              break
          }
        }
      })
    }

    new MessageQueueImmediate(device)
    new MessageRouterTestCallback(device, underlyingDevice)

    const connectionHandshake = new BinaryConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
      requestObjectsMessageID:
        MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
      listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
      amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
    })

    const progressSpy = sinon.spy()
    const errorSpy = sinon.spy()
    const completeSpy = sinon.spy()

    let abc
    let def

    device.on('data', (message: Message) => {
      switch (message.messageID) {
        case 'abc':
          abc = message.payload
          break
        case 'def':
          def = message.payload
          break
        default:
          break
      }
    })

    const promise = new Promise((resolve, reject) => {
      const subscription = connectionHandshake.observable.subscribe(
        progressSpy,
        errorSpy,
        completeSpy,
      )

      unsubscribeHandler = () => subscription.unsubscribe()

      setTimeout(resolve, 10)
    })

    await promise

    assert.isFalse(completeSpy.called)
    // it'll also throw if it does anything
  })
})
