import 'mocha'

import * as chai from 'chai'
import * as sinon from 'sinon'
import { PassThrough } from 'stream'

import {
  Connection,
  ConnectionInterface,
  Device,
  DeviceManager,
  Message,
  MessageQueueImmediate,
  MessageRouterTestCallback,
  Progress,
} from '@electricui/core'
import {
  MESSAGEID_INCOMING_RO_MESSAGEIDS_COUNT,
  MESSAGEID_INCOMING_RO_MESSAGEIDS_LIST,
  MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
  MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
  MESSAGEID_REQUEST_RO_MESSAGEIDS,
  MESSAGEID_REQUEST_RO_OBJECTS,
  MESSAGEID_REQUEST_RW_MESSAGEIDS,
  MESSAGEID_REQUEST_RW_OBJECTS,
  Packet,
  TYPES,
} from '@electricui/protocol-constants'

import { ConnectionHandshake, RECEIVED, RECEIVED_COUNT, REQUEST, TIMEOUT } from '../src/handshake'

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
            case MESSAGEID_REQUEST_RW_MESSAGEIDS:
              const listMessage = new Message(
                MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
                ['abc', 'def'],
              )
              listMessage.metadata.internal = true

              const countMessage = new Message(
                MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
                2,
              )
              countMessage.metadata.internal = true

              device.receive(listMessage, connection)
              device.receive(countMessage, connection)

              break
            case MESSAGEID_REQUEST_RW_OBJECTS:
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

    const connectionHandshake = new ConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEID_REQUEST_RW_MESSAGEIDS,
      requestObjectsMessageID: MESSAGEID_REQUEST_RW_OBJECTS,
      listMessageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
      amountMessageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
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
        console.log('underying', message)

        if (message.metadata.query) {
          // if something gets queried,
          device.receive(new Message(message.messageID, 0), connection)
        } else if (message.metadata.type === TYPES.CALLBACK) {
          switch (message.messageID) {
            case MESSAGEID_REQUEST_RW_MESSAGEIDS:
              switch (listRequestNumber) {
                case 0:
                  // send nothing first time
                  break
                case 1:
                  // send half the messages second time
                  const listMessage1 = new Message(
                    MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
                    ['abc'],
                  )
                  listMessage1.metadata.internal = true

                  const countMessage1 = new Message(
                    MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
                    2,
                  )
                  countMessage1.metadata.internal = true

                  device.receive(listMessage1, connection)
                  device.receive(countMessage1, connection)
                  break

                default:
                  // send all messages the third time
                  const listMessage2 = new Message(
                    MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
                    ['abc', 'def'],
                  )
                  listMessage2.metadata.internal = true

                  const countMessage2 = new Message(
                    MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
                    2,
                  )
                  countMessage2.metadata.internal = true

                  device.receive(listMessage2, connection)
                  device.receive(countMessage2, connection)
                  break
              }

              listRequestNumber = listRequestNumber + 1
              break
            case MESSAGEID_REQUEST_RW_OBJECTS:
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

    const connectionHandshake = new ConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEID_REQUEST_RW_MESSAGEIDS,
      requestObjectsMessageID: MESSAGEID_REQUEST_RW_OBJECTS,
      listMessageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
      amountMessageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
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

    const connectionHandshake = new ConnectionHandshake({
      device: device,
      externalTiming: true,
      requestListMessageID: MESSAGEID_REQUEST_RW_MESSAGEIDS,
      requestObjectsMessageID: MESSAGEID_REQUEST_RW_OBJECTS,
      listMessageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
      amountMessageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
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
})
