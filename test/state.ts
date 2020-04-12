import * as chai from 'chai'
import * as sinon from 'sinon'

import BinaryConnectionHandshake, {
  RECEIVED,
  RECEIVED_COUNT,
  REQUEST,
  TIMEOUT,
} from '../src/handshake'
import {
  Device,
  DeviceManager,
  Message,
  MessageQueueImmediate,
  MessageRouterTestCallback,
  Progress,
} from '@electricui/core'
import { Observable, Observer } from 'rxjs'

import { TYPES } from '@electricui/protocol-binary-constants'
import { delay } from 'bluebird'

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
  test('finishes when the correct amount is received', () => {
    const { connectionHandshake, completeSpy } = testFactory()

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 2 })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    expect(connectionHandshake.currentState.value).toBe('finish')
    expect(completeSpy.called).toBe(true)
    connectionHandshake.detachHandlers()
  })

  test('retries when the incorrect amount is received', async () => {
    const { connectionHandshake, completeSpy, writeToDeviceSpy } = testFactory()

    connectionHandshake.dispatch({ type: REQUEST })
    connectionHandshake.dispatch({ type: RECEIVED, payload: ['abc', 'def'] })
    connectionHandshake.dispatch({ type: RECEIVED_COUNT, payload: 2 })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 123, }) // prettier-ignore
    connectionHandshake.dispatch({ type: TIMEOUT })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    expect(writeToDeviceSpy.called).toBe(true)

    // it should be the third call
    const queryMessage: Message = writeToDeviceSpy.getCall(2).args[0]

    expect(queryMessage.messageID).toEqual('def')
    expect(queryMessage.metadata.query).toBe(true)

    expect(connectionHandshake.currentState.value).toBe('finish')
    expect(completeSpy.called).toBe(true)
    connectionHandshake.detachHandlers()
  })

  test('retries a fixed amount of times when missing members of the message ID list', () => {
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

    expect(connectionHandshake.currentState.value).toBe('fail')
    expect(errorSpy.called).toBe(true)
    connectionHandshake.detachHandlers()
  })

  test('succeeds when only getting partial data per retry', () => {
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
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'ghi', payload: 456, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'jki', payload: 456, }) // prettier-ignore

    expect(connectionHandshake.currentState.value).toBe('finish')
    expect(completeSpy.called).toBe(true)
    connectionHandshake.detachHandlers()
  })

  test('succeeds with duplicate data being sent', () => {
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

    // Send duplicate data
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'abc', payload: 324, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'def', payload: 456, }) // prettier-ignore

    connectionHandshake.dispatch({ type: TIMEOUT })
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'ghi', payload: 456, }) // prettier-ignore
    connectionHandshake.dispatch({ type: RECEIVED, messageID: 'jki', payload: 456, }) // prettier-ignore

    expect(connectionHandshake.currentState.value).toBe('finish')
    expect(completeSpy.called).toBe(true)
    connectionHandshake.detachHandlers()
  })
})
