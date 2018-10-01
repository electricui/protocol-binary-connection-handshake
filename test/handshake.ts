import 'mocha'

import * as chai from 'chai'
import * as sinon from 'sinon'
import {
  PassThrough
} from 'stream'

import {
  Packet,
  TYPES
} from '@electricui/protocol-constants'

import {
  ConnectionHandshake,
  RECEIVED,
  RECEIVED_COUNT,
  REQUEST,
  TIMEOUT
} from '../src/handshake'

// TODO: work out why this isn't working
const MESSAGEID_REQUEST_RO_MESSAGEIDS = 'dmr'
const MESSAGEID_INCOMING_RO_MESSAGEIDS_LIST = 'dmrl'
const MESSAGEID_INCOMING_RO_MESSAGEIDS_COUNT = 'dmre'
const MESSAGEID_REQUEST_RW_MESSAGEIDS = 'dmw'
const MESSAGEID_INCOMING_RW_MESSAGEIDS_LIST = 'dmwl'
const MESSAGEID_INCOMING_RW_MESSAGEIDS_COUNT = 'dmwe'
const MESSAGEID_REQUEST_RO_OBJECTS = 'dvr'
const MESSAGEID_REQUEST_RW_OBJECTS = 'dvw'

const assert = chai.assert

const delay = (delay: number) => {
  return new Promise((res, rej) => {
    setTimeout(res, delay)
  })
}

const testDeviceID = 'deviceID'

describe('Connection Handshake', () => {
  it('performes a handshake through the happy path', done => {
    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

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
            case MESSAGEID_REQUEST_RW_OBJECTS:
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
      deviceID: testDeviceID,
    })

    const promise = connectionHandshake.connect()

    promise.then((res: any) => {
      assert.equal(res.abc, 0)
      assert.equal(res.def, 0)
      done()
    })
  })
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
  })
})
