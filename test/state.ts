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

const assert = chai.assert

describe('Connection Handshake State Machine', () => {
  it('finishes when the correct amount is received', () => {
    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

    const connectionHandshake = new ConnectionHandshake({
      readInterface,
      writeInterface,
    })

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 2 })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    assert.strictEqual(connectionHandshake.currentState.value, 'finish')
  })

  it('retries when the incorrect amount is received', () => {
    const sendCallbackSpy = sinon.spy()
    const sendQuerySpy = sinon.spy()

    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

    writeInterface.on('data', (packet: Packet) => {
      if (packet.query) {
        sendQuerySpy(packet.messageID)
      } else if (packet.type === TYPES.CALLBACK) {
        sendCallbackSpy(packet.messageID)
      }
    })

    const connectionHandshake = new ConnectionHandshake({
      readInterface,
      writeInterface,
    })

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 2 })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: TIMEOUT })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    assert.isTrue(sendQuerySpy.called)
    assert.deepEqual(sendQuerySpy.getCall(0).args[0], 'def')

    assert.strictEqual(connectionHandshake.currentState.value, 'finish')
  })

  it('retries a fixed amount of times when missing members of the message ID list', () => {
    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

    const connectionHandshake = new ConnectionHandshake({
      readInterface,
      writeInterface,
    })

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 4 })

    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 4 })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 4 })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 4 })

    assert.strictEqual(connectionHandshake.currentState.value, 'fail')
  })

  it('succeeds when only getting partial data per retry', () => {
    const readInterface = new PassThrough({ objectMode: true })
    const writeInterface = new PassThrough({ objectMode: true })

    const connectionHandshake = new ConnectionHandshake({
      readInterface,
      writeInterface,
    })

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    // missing half of packet
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 4 })
    // missing other half of packet
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['ghi', 'jki'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 4 })

    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore
    connectionHandshake.dispatch({ type: TIMEOUT })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore
    connectionHandshake.dispatch({ type: TIMEOUT })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'ghi', payload: 456, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'jki', payload: 456, }) // prettier-ignore

    assert.strictEqual(connectionHandshake.currentState.value, 'finish')
  })
})
