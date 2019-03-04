import 'mocha'

import { delay } from 'bluebird'
import * as chai from 'chai'
import { Observable, Observer } from 'rxjs'
import * as sinon from 'sinon'

import {
  Device,
  DeviceManager,
  Message,
  MessageQueueImmediate,
  MessageRouterTestCallback,
  Progress,
} from '@electricui/core'
import { TYPES } from '@electricui/protocol-binary-constants'

import BinaryConnectionHandshake, {
  RECEIVED,
  RECEIVED_COUNT,
  REQUEST,
  TIMEOUT,
} from '../src/handshake'

const assert = chai.assert

const testFactory = () => {
  const writeToDeviceSpy = sinon.spy()
  const deviceManager = new DeviceManager()
  const device = new Device('mock', deviceManager)

  // create a message queue that binds to the device that returns immediately
  new MessageQueueImmediate(device)

  // async function because it returns a promise which is expected by the router
  new MessageRouterTestCallback(device, async (message: Message) => {
    writeToDeviceSpy(message)
  })

  const connectionHandshake = new BinaryConnectionHandshake({
    device: device,
    externalTiming: true,
    requestListMessageID: 'c',
    requestObjectsMessageID: 'd',
    listMessageID: 'b',
    amountMessageID: 'a',
    preset: 'custom',
  })

  const progressSpy = sinon.spy()
  const errorSpy = sinon.spy()
  const completeSpy = sinon.spy()
  connectionHandshake.observable.subscribe(progressSpy, errorSpy, completeSpy)

  return {
    deviceManager,
    device,
    connectionHandshake,
    progressSpy,
    errorSpy,
    completeSpy,
    writeToDeviceSpy,
  }
}

describe('Connection Handshake State Machine', () => {
  it('finishes when the correct amount is received', () => {
    const { connectionHandshake, completeSpy } = testFactory()

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 2 })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    assert.strictEqual(connectionHandshake.currentState.value, 'finish')
    assert.isTrue(completeSpy.called)
  })

  it('retries when the incorrect amount is received', async () => {
    const { connectionHandshake, completeSpy, writeToDeviceSpy } = testFactory()

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 2 })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: TIMEOUT })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    assert.isTrue(writeToDeviceSpy.called)

    // it should be the third call
    const queryMessage: Message = writeToDeviceSpy.getCall(2).args[0]

    assert.deepEqual(queryMessage.messageID, 'def')
    assert.isTrue(queryMessage.metadata.query)

    assert.strictEqual(connectionHandshake.currentState.value, 'finish')
    assert.isTrue(completeSpy.called)
  })

  it('retries a fixed amount of times when missing members of the message ID list', () => {
    const { connectionHandshake, errorSpy } = testFactory()

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
    assert.isTrue(errorSpy.called)
  })

  it('succeeds when only getting partial data per retry', () => {
    const { connectionHandshake, completeSpy } = testFactory()

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
    assert.isTrue(completeSpy.called)
  })
})
