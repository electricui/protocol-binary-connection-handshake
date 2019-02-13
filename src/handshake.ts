import { matchesState, Machine } from 'xstate'

import { Device, DeviceHandshake, Message, Progress } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'

const debug = require('debug')(
  'electricui-binary-connection-handshake:handshake',
)

interface Event {
  type: string
  payload?: any
  messageID?: string
}

type Dispatch = (event: Event) => void

interface ActionMap {
  [key: string]: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => void
}

const actionMap: ActionMap = {
  requestList: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    return fullState.sendCallback(fullState.requestListMessageID)
  },
  requestObjects: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    return fullState.sendCallback(fullState.requestObjectsMessageID)
  },
  appendReceived: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    const allSet = new Set(fullState.messageIDsReceived)

    for (const messageID of event.payload) {
      allSet.add(messageID)
    }

    // this will replace our fullState
    fullState.messageIDsReceived = Array.from(allSet.values())
  },
  populateHashmap: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    const allReceived = fullState.messageIDsReceived

    for (const messageID of allReceived) {
      fullState.messageIDObjects.set(messageID, undefined)
    }
  },
  requestIndividual: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    const allMessageIDs = fullState.messageIDsReceived

    for (const messageID of allMessageIDs) {
      if (fullState.messageIDObjects.get(messageID) === undefined) {
        fullState.sendQuery(messageID).catch(err => {
          console.log("Couldn't request individual", messageID)
        })
      }
    }

    console.error("Couldn't find any messageIDs to query?")
  },
  incrementRetries: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    fullState.retries = fullState.retries + 1
  },
  resetRetries: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    fullState.retries = 0
  },
  setIndividualRequestMode: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    fullState.individualRequestMode = true
  },
  onFinish: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.onFinish()
  },
  onFail: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.onFail()
  },
}

// transitions
export const REQUEST = 'REQUEST'
export const RECEIVED = 'RECEIVED'
export const TIMEOUT = 'TIMEOUT'
export const RECEIVED_COUNT = 'RECEIVED_COUNT'
export const RECEIVED_OBJECT = 'RECEIVED_OBJECT'

const stateMachine = Machine(
  {
    initial: 'request_ids',
    key: 'handshake',
    states: {
      request_ids: {
        initial: 'request_amount',
        states: {
          request_amount: {
            on: {
              REQUEST: {
                await_list: {
                  actions: ['requestList'],
                },
              },
              TIMEOUT: [
                {
                  target: 'request_amount',
                  cond: 'belowMaxRetries',
                  actions: ['requestList', 'incrementRetries'],
                },
                { target: '#handshake.fail' },
              ],
            },
          },
          await_list: {
            on: {
              RECEIVED: {
                await_list: {
                  actions: ['appendReceived'],
                },
              },
              TIMEOUT: [
                {
                  target: 'await_list',
                  cond: 'belowMaxRetries',
                  actions: ['requestList', 'incrementRetries'],
                },
                { target: '#handshake.fail' },
              ],
              RECEIVED_COUNT: [
                {
                  target: '#handshake.request_objects',
                  cond: 'correctAmountOfMessageIDsRecevied',
                },
                {
                  target: 'await_list',
                  cond: 'belowMaxRetries',
                  actions: ['requestList', 'incrementRetries'],
                },
                { target: '#handshake.fail' },
              ],
            },
          },
        },
      },
      request_objects: {
        initial: 'await_objects',
        onEntry: ['populateHashmap', 'resetRetries', 'requestObjects'],
        states: {
          await_objects: {
            on: {
              RECEIVED: [
                {
                  target: '#handshake.finish',
                  cond: 'addObjectCheckIfAllReceived',
                },
                {
                  target: 'await_objects',
                  cond: 'isInIndividualRequestMode',
                  actions: ['requestIndividual'],
                },
                {
                  target: 'await_objects',
                },
              ],
              TIMEOUT: [
                {
                  target: 'await_objects',
                  cond: 'shouldRetryAll',
                  actions: ['requestObjects', 'incrementRetries'],
                },
                {
                  target: 'await_objects',
                  cond: 'belowMaxRetries',
                  actions: [
                    'setIndividualRequestMode',
                    'requestIndividual',
                    'incrementRetries',
                  ],
                },
                { target: '#handshake.fail' },
              ],
            },
          },
        },
      },
      finish: {
        onEntry: ['onFinish'],
      },
      fail: {
        onEntry: ['onFail'],
      },
    },
  },
  {
    guards: {
      correctAmountOfMessageIDsRecevied: (fullState: FullStateShape, event) => {
        const ourCount = fullState.messageIDsReceived.length
        const reportedCount = event.payload

        return ourCount === reportedCount
      },
      belowMaxRetries: (fullState: FullStateShape, event) => {
        const retries = fullState.retries
        const maxRetries = fullState.maxRetries

        return retries <= maxRetries
      },
      shouldRetryAll: (fullState: FullStateShape, event) => {
        const retries = fullState.retries
        const maxRetries = fullState.maxRetries

        if (retries > maxRetries) {
          return false
        }

        // if we haven't received anything, retry all
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          if (value !== undefined) {
            return false
          }
        }

        return true
      },
      addObjectCheckIfAllReceived: (fullState: FullStateShape, event) => {
        // add the object
        fullState.messageIDObjects.set(event.messageID, event.payload)

        // and check if we're done
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          if (value === undefined) {
            return false
          }
        }

        return true
      },
      isInIndividualRequestMode: (fullState: FullStateShape, event) => {
        return fullState.individualRequestMode
      },
    },
  },
)

interface FullStateShape {
  requestListMessageID: string
  requestObjectsMessageID: string
  listMessageID: string
  amountMessageID: string
  messageIDsReceived: Array<string>
  messageIDObjects: Map<string, any>
  retries: number
  maxRetries: number
  individualRequestMode: boolean

  numberOfMessageIDs: number

  sendCallback: (messageID: string) => Promise<void>
  sendQuery: (messageID: string) => Promise<void>

  onFinish: () => void
  onFail: () => void
}

interface ConnectionHandshakeOptions {
  device: Device
  timeout?: number
  externalTiming?: boolean
  preset: 'custom' | 'readonly' | 'readwrite'
  requestListMessageID?: string
  requestObjectsMessageID?: string
  listMessageID?: string
  amountMessageID?: string
}

interface HandshakeMessageIDs {
  requestListMessageID: string
  requestObjectsMessageID: string
  listMessageID: string
  amountMessageID: string
}

interface ResponseObject {
  [key: string]: any
}

export default class BinaryConnectionHandshake extends DeviceHandshake {
  currentState = stateMachine.initialState // starts as request_amount
  fullState: FullStateShape
  _lastReceived: number = 0
  _externalTiming: boolean
  timeout: number
  _interval: NodeJS.Timer | null = null
  _loopInterval: number = 50

  constructor(options: ConnectionHandshakeOptions) {
    super(options.device)
    let messageIDs: HandshakeMessageIDs

    if (options.preset === 'custom') {
      if (
        !options.requestListMessageID ||
        !options.requestObjectsMessageID ||
        !options.amountMessageID ||
        !options.listMessageID
      ) {
        throw new Error(
          'Need to specify all messageIDs when not using a preset with a BinaryConnectionHandshake',
        )
      }

      messageIDs = {
        requestListMessageID: options.requestListMessageID,
        requestObjectsMessageID: options.requestObjectsMessageID,
        amountMessageID: options.amountMessageID,
        listMessageID: options.listMessageID,
      }
    } else if (options.preset === 'readonly') {
      messageIDs = {
        requestListMessageID: MESSAGEIDS.READONLY_MESSAGEIDS_REQUEST_LIST,
        requestObjectsMessageID:
          MESSAGEIDS.READONLY_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
        listMessageID: MESSAGEIDS.READONLY_MESSAGEIDS_ITEM,
        amountMessageID: MESSAGEIDS.READONLY_MESSAGEIDS_COUNT,
      }
    } else {
      messageIDs = {
        requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
        requestObjectsMessageID:
          MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
        listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
        amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
      }
    }

    this.fullState = {
      ...messageIDs,
      // extended state

      messageIDsReceived: [],
      messageIDObjects: new Map(),
      retries: 0,
      maxRetries: 2,
      individualRequestMode: false,

      numberOfMessageIDs: 0,

      sendCallback: this.sendCallback,
      sendQuery: this.sendQuery,

      onFinish: this.onFinish,
      onFail: this.onFail,
    }

    this.timeout = options.timeout || 1000
    this._externalTiming = options.externalTiming || false
  }

  onSubscribe() {
    this.connect()
  }

  getNow = () => {
    return new Date().getTime()
  }

  dispatch = (event: Event) => {
    const nextState = stateMachine.transition(
      this.currentState,
      event,
      this.fullState,
    )

    nextState.actions.forEach(actionKey => {
      const action = actionMap[String(actionKey)]

      if (action) {
        // run the action, they can directly mutate state if they want.

        action(this.fullState, event, this.dispatch)
      }
    })

    debug('DISPATCH', this.currentState.value, event, nextState.value)

    // update the current state
    this.currentState = nextState
  }

  sendCallback = (messageID: string) => {
    debug('Sent Callback', messageID)

    // Send a Buffer.alloc(0) instead of a null as a micro-optimisation + please the type codecs
    const callback = new Message(messageID, Buffer.alloc(0))
    callback.metadata.type = TYPES.CALLBACK
    callback.metadata.internal = true
    callback.metadata.query = false

    return this.device.write(callback).catch(err => {
      console.warn("Couldn't send callback during handshake")
    })
  }

  sendQuery = (messageID: string) => {
    debug('Sent Query', messageID)

    // Send a Buffer.alloc(0) instead of a null as a micro-optimisation + please the type codecs
    const callback = new Message(messageID, Buffer.alloc(0))
    callback.metadata.type = TYPES.CALLBACK
    callback.metadata.internal = false
    callback.metadata.query = true

    return this.device.write(callback).catch(err => {
      console.warn("Couldn't send query during handshake")
    })
  }

  onFinish = () => {
    this.detachHandlers()

    debug('Handshake succeeded!')

    // We don't need to send these since the device manager intrinsically receives messages from the device.
    /*
    for (const [messageID, payload] of this.fullState.messageIDObjects) {
      const message = new Message(messageID, payload)
      message.metadata.internal = false
      message.deviceID = this.device.getDeviceID() // Annotate the message with the DeviceID

      this.device.manager.receive(this.device, message)
    }
    */

    this.complete()
  }

  onFail = () => {
    this.detachHandlers()
    debug('Failed handshake...')
    this.error(new Error('Maximum retries hit.'))
  }

  receiveHandler = (message: Message) => {
    const internal = <boolean>message.metadata.internal
    const messageID = message.messageID
    const payload = message.payload

    if (internal) {
      switch (messageID) {
        case this.fullState.listMessageID:
          this.dispatch({ type: RECEIVED, payload })
          this._lastReceived = this.getNow()
          return
        case this.fullState.amountMessageID:
          this.fullState.numberOfMessageIDs = payload
          this.dispatch({ type: RECEIVED_COUNT, payload })
          this._lastReceived = this.getNow()
          return

        default:
          return
      }
    }

    if (
      matchesState(this.currentState.value, 'request_objects.await_objects')
    ) {
      this.dispatch({ type: RECEIVED, messageID, payload })
      this._lastReceived = this.getNow()
    }
  }

  attachHandlers = () => {
    debug(`Attaching handlers`)
    this.device.on('data', this.receiveHandler)
    if (!this._externalTiming) {
      this._interval = setInterval(() => {
        this.loop(this.getNow())
      }, this._loopInterval)
    }
  }

  detachHandlers = () => {
    debug(`Detaching handlers`)
    this.device.removeListener('data', this.receiveHandler)
    if (this._interval) {
      clearInterval(this._interval)
    }
  }

  connect = () => {
    debug(`Starting Handshake`)

    this.attachHandlers()

    // send initial request
    this.dispatch({ type: REQUEST })

    this.progress(new Progress(0, 0, 'Requesting '))
  }

  loop = (now: number) => {
    debug(`Event loop`)
    if (now - this._lastReceived > this.timeout) {
      debug(`Timed out during:`, this.currentState.value)
      this.dispatch({ type: TIMEOUT })
      this._lastReceived = now
    }
  }

  onCancel() {
    this.detachHandlers()
  }
}
