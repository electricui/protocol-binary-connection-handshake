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
  /*
  it('performes a handshake with list retries and object retries', async () => {
    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

    let listRequestNumber = 0
    let objectRequestNumber = 0

    // this is a mock device
    writeInterface.on('data', (packet: Packet) => {
      // we have to do this asyncronously
      setImmediate(() => {
        if (packet.query) {
          // if something gets queried,
          readInterface.write({ messageID: packet.messageID, payload: 0 })
        } else if (packet.type === TYPES.CALLBACK) {
          switch (packet.messageID) {
            case MESSAGEID_REQUEST_RW_MESSAGEIDS:
              switch (listRequestNumber) {
                case 0:
                  // send nothing first time
                  break
                case 1:
                  // send half the messages second time
                  readInterface.write({
                    messageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
                    payload: ['abc'],
                    internal: true,
                    deviceID: testDeviceID,
                  })
                  readInterface.write({
                    messageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
                    payload: 2,
                    internal: true,
                    deviceID: testDeviceID,
                  })
                  break

                default:
                  // send all messages the third time
                  readInterface.write({
                    messageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST,
                    payload: ['abc', 'def'],
                    internal: true,
                    deviceID: testDeviceID,
                  })
                  readInterface.write({
                    messageID: MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT,
                    payload: 2,
                    internal: true,
                    deviceID: testDeviceID,
                  })

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
                  readInterface.write({
                    messageID: 'abc',
                    payload: 0,
                    deviceID: testDeviceID,
                  })
                  break

                default:
                  // send all the third time
                  readInterface.write({
                    messageID: 'abc',
                    payload: 0,
                    deviceID: testDeviceID,
                  })
                  readInterface.write({
                    messageID: 'def',
                    payload: 0,
                    deviceID: testDeviceID,
                  })

                  break
              }

              objectRequestNumber = objectRequestNumber + 1
              break
            default:
              break
          }
        }
      })
    })

    const connectionHandshake = new ConnectionHandshake({
      readInterface,
      writeInterface,
      externalTiming: true, // we override the timing system so we can do testing faster
      timeout: 1, // 1 ms
      deviceID: testDeviceID,
    })

    let time = 0
    connectionHandshake.getNow = () => time
    const promise = connectionHandshake.connect()

    await delay(5)

    // loop 5 seconds into the future, catch the first timeout of the list

    time = 5000
    connectionHandshake.getNow = () => time
    connectionHandshake.loop(time)

    await delay(5)

    // loop 5 seconds into the future, catch the second timeout for the objects

    time = 10000
    connectionHandshake.getNow = () => time
    connectionHandshake.loop(time)

    await delay(5)

    time = 15000
    connectionHandshake.getNow = () => time
    connectionHandshake.loop(time)

    await delay(5)

    return promise.then((res: any) => {
      assert.equal(res.abc, 0)
      assert.equal(res.def, 0)
    })
  })

  it('rejects on timeout', async () => {
    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

    let listRequestNumber = 0
    let objectRequestNumber = 0

    const connectionHandshake = new ConnectionHandshake({
      readInterface,
      writeInterface,
      externalTiming: true, // we override the timing system so we can do testing faster
      timeout: 1, // 1 ms
      deviceID: testDeviceID,
    })

    let time = 0
    connectionHandshake.getNow = () => time
    const promise = connectionHandshake.connect().catch((err: any) => {
      assert.isDefined(err)
    })

    // loop 5 seconds into the future, catch the first timeout of the list

    for (let index = 0; index < 4; index++) {
      time += 5000
      connectionHandshake.getNow = () => time
      connectionHandshake.loop(time)

      await delay(5)
    }

    return promise
  })*/
})
