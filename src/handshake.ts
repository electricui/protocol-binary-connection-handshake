import { matchesState, Machine } from 'xstate'

import {
  Device,
  DeviceHandshake,
  Message,
  Progress,
  DEVICE_EVENTS,
} from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { mark, measure } from './perf'

const debug = require('debug')(
  'electricui-protocol-binary:connection-handshake',
)

interface Event {
  type: string
  payload?: any
  messageID?: string
}

interface MessageEvent extends Event {
  messageID: string
}

type Dispatch = (event: Event) => void

interface ActionMap {
  [key: string]: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => void
}

export const enum PROGRESS_KEYS {
  FINISHED = 'finished',
  RECEIVED_AMOUNT_OF_MESSAGEIDS = 'received-amount-of-messageids',
  RECEIVED_MESSAGEID = 'received-messageid',
  REQUEST_LIST = 'request-list',
  REQUEST_OBJECTS = 'request-objects',
  REQUEST_INDIVIDUAL = 'request-individual',
  FAILED = 'failed',
}

const actionMap: ActionMap = {
  requestList: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    mark(`binary-handshake:request-list`)

    fullState.updateProgress(PROGRESS_KEYS.REQUEST_LIST, {
      retries: fullState.retries,
    })

    return fullState.sendCallback(fullState.requestListMessageID)
  },
  requestObjects: (
    fullState: FullStateShape,
    event: Event,
    dispatch: Dispatch,
  ) => {
    mark(`binary-handshake:request-objects`)

    fullState.updateProgress(PROGRESS_KEYS.REQUEST_OBJECTS, {
      retries: fullState.retries,
    })

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

        fullState.updateProgress(PROGRESS_KEYS.REQUEST_INDIVIDUAL, {
          messageID,
          retries: fullState.retries,
        })

        return
      }
    }

    throw new Error(
      `All ${
        allMessageIDs.length
      } messageIDs had data, why requesting individual?`,
    )
  },
  addObject: (
    fullState: FullStateShape,
    event: MessageEvent,
    dispatch: Dispatch,
  ) => {
    if (fullState.messageIDObjects.get(event.messageID) !== undefined) {
      debug(
        `received ${
          event.messageID
        } again, payload was ${fullState.messageIDObjects.get(
          event.messageID,
        )}, and is now ${event.payload}`,
      )
    }

    if (event.payload === undefined) {
      console.log(
        `Event payload for ${event.messageID} was undefined, setting to null`,
      )
      event.payload = null
    }

    fullState.messageIDObjects.set(event.messageID, event.payload)
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
  onFinish: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.onFinish()
  },
  onFail: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.onFail()
  },
}

// Transitions
export const REQUEST = 'REQUEST'
export const RECEIVED = 'RECEIVED'
export const TIMEOUT = 'TIMEOUT'
export const RECEIVED_COUNT = 'RECEIVED_COUNT'
export const RECEIVED_OBJECT = 'RECEIVED_OBJECT'

const stateMachine = Machine(
  {
    id: 'binary-handshake',
    initial: 'request_ids',
    key: 'handshake',
    states: {
      request_ids: {
        initial: 'request_amount',
        states: {
          request_amount: {
            on: {
              REQUEST: {
                target: 'await_list',
                actions: ['requestList'],
              },
              TIMEOUT: [
                {
                  target: 'request_amount',
                  cond: 'belowMaxRetries',
                  actions: ['incrementRetries', 'requestList'],
                },
                { target: '#handshake.fail' },
              ],
            },
          },
          await_list: {
            on: {
              RECEIVED_COUNT: [
                {
                  target: '#handshake.request_objects_bulk',
                  cond: 'correctAmountOfMessageIDsRecevied',
                },
                {
                  target: 'await_list',
                  cond: 'belowMaxRetries',
                  actions: ['incrementRetries', 'requestList'],
                },
                { target: '#handshake.fail' },
              ],
              RECEIVED: {
                target: 'await_list',
                actions: ['appendReceived'],
              },
              TIMEOUT: [
                {
                  target: 'await_list',
                  cond: 'belowMaxRetries',
                  actions: ['incrementRetries', 'requestList'],
                },
                { target: '#handshake.fail' },
              ],
            },
          },
        },
      },
      request_objects_bulk: {
        initial: 'await_objects',
        onEntry: ['populateHashmap', 'resetRetries', 'requestObjects'],
        states: {
          await_objects: {
            on: {
              RECEIVED: [
                {
                  cond: 'allReceivedWhenThisAdded',
                  actions: ['addObject'],
                  target: '#handshake.finish',
                },
                {
                  target: 'await_objects',
                  actions: ['addObject'],
                },
              ],
              TIMEOUT: [
                {
                  target: 'await_objects',
                  cond: 'shouldRetryAll',
                  actions: ['requestObjects', 'incrementRetries'],
                },
                {
                  target: '#handshake.request_objects_individually',
                  cond: 'belowMaxRetries',
                },
              ],
            },
          },
        },
      },
      request_objects_individually: {
        initial: 'await_object',
        onEntry: ['resetRetries', 'requestIndividual'],
        states: {
          await_object: {
            on: {
              RECEIVED: [
                {
                  cond: 'allReceivedWhenThisAdded',
                  actions: ['addObject'],
                  target: '#handshake.finish',
                },
                {
                  cond: 'individualsLeftToRequest',
                  actions: ['addObject', 'requestIndividual'],
                  target: 'await_object',
                },
              ],
              TIMEOUT: [
                {
                  target: 'await_object',
                  cond: 'belowMaxRetries',
                  actions: ['requestIndividual', 'incrementRetries'],
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
      allReceivedWhenThisAdded: (
        fullState: FullStateShape,
        event: MessageEvent,
      ) => {
        // and check if we're done
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          // Check if this messageID is empty, doing a special case check for
          // the message we're in the middle of receiving
          if (value === undefined && messageID !== event.messageID) {
            return false
          }
        }

        return true
      },
      individualsLeftToRequest: (fullState: FullStateShape, event) => {
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          if (value === undefined) {
            return true
          }
        }

        return false
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

  numberOfMessageIDs: number

  sendCallback: (messageID: string) => Promise<void>
  sendQuery: (messageID: string) => Promise<void>
  updateProgress: (progressKey: PROGRESS_KEYS, meta?: ProgressMeta) => void

  onFinish: () => void
  onFail: () => void
}

interface ConnectionHandshakeOptions {
  device: Device
  timeout?: number
  preset: 'custom' | 'default'
  requestListMessageID?: string
  requestObjectsMessageID?: string
  listMessageID?: string
  amountMessageID?: string
  /**
   * Each progress message can be customised with either a string or a function that receives the retry number
   */
  progressMessages?: {}
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

interface ProgressMeta {
  messageID?: string
  retries?: number
}

export default class BinaryConnectionHandshake extends DeviceHandshake {
  currentState = stateMachine.initialState // starts as request_amount
  fullState: FullStateShape
  _lastReceived: number = 0
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

      numberOfMessageIDs: 0,

      sendCallback: this.sendCallback,
      sendQuery: this.sendQuery,
      updateProgress: this.updateProgress,

      onFinish: this.onFinish,
      onFail: this.onFail,
    }

    this.timeout = options.timeout || 1000
  }

  onSubscribe() {
    this.connect()
  }

  getNow = () => {
    return new Date().getTime()
  }

  dispatch = (event: Event) => {
    // Calculate the next state
    const nextState = stateMachine.transition(
      this.currentState,
      event,
      this.fullState,
    )

    // Action before transition
    nextState.actions.forEach(actionKey => {
      const action = actionMap[String(actionKey)]

      if (action) {
        // run the action, they can directly mutate state if they want.
        action(this.fullState, event, this.dispatch)
      }
    })

    debug('DISPATCH', this.currentState.value, event, nextState.value)

    // Commit the transition to the next state
    this.currentState = nextState
  }

  sendCallback = (messageID: string) => {
    debug('Sent Callback', messageID)

    const callback = new Message(messageID, null)
    callback.metadata.type = TYPES.CALLBACK
    callback.metadata.internal = true
    callback.metadata.query = false

    const reply = this.device.write(callback)

    return reply.catch(err => {
      console.warn("Couldn't send callback during handshake")
    })
  }

  sendQuery = (messageID: string) => {
    debug('Sent Query', messageID)

    const callback = new Message(messageID, null)
    callback.metadata.type = TYPES.CALLBACK
    callback.metadata.internal = false
    callback.metadata.query = true

    return this.device.write(callback).catch(err => {
      console.warn("Couldn't send query during handshake")
    })
  }

  onFinish = () => {
    measure(`binary-handshake:request-objects`)
    this.detachHandlers()

    debug('Handshake succeeded!')

    this.updateProgress(PROGRESS_KEYS.FINISHED)

    this.complete()
  }

  onFail = () => {
    this.detachHandlers()
    debug('Failed handshake...')
    this.updateProgress(PROGRESS_KEYS.FAILED)
    this.error(new Error('Maximum retries hit.'))
  }

  receiveHandler = (message: Message) => {
    const internal = <boolean>message.metadata.internal
    const messageID = message.messageID
    const payload = message.payload

    if (internal) {
      switch (messageID) {
        case this.fullState.listMessageID:
          measure(`binary-handshake:request-list`)
          this.dispatch({ type: RECEIVED, payload })
          this._lastReceived = this.getNow()
          return
        case this.fullState.amountMessageID:
          this.fullState.numberOfMessageIDs = payload
          this.dispatch({ type: RECEIVED_COUNT, payload })
          this._lastReceived = this.getNow()

          // Indicate that we've received something
          this.updateProgress(PROGRESS_KEYS.RECEIVED_AMOUNT_OF_MESSAGEIDS)

          return
        default:
          return
      }
    }

    // it's a developer packet
    if (
      matchesState(
        this.currentState.value,
        'request_objects_bulk.await_objects',
      ) ||
      matchesState(
        this.currentState.value,
        'request_objects_individually.await_objects',
      )
    ) {
      this.dispatch({ type: RECEIVED, messageID, payload })

      this._lastReceived = this.getNow()

      this.updateProgress(PROGRESS_KEYS.RECEIVED_MESSAGEID, {
        messageID,
      })
    }
  }

  updateProgress = (progressKey: PROGRESS_KEYS, meta: ProgressMeta = {}) => {
    let progress = Array.from(this.fullState.messageIDObjects.values()).filter(
      val => val !== undefined,
    ).length
    let total = this.fullState.numberOfMessageIDs

    let text = ''

    text = JSON.stringify({ progressKey, meta })

    switch (progressKey) {
      case PROGRESS_KEYS.RECEIVED_MESSAGEID:
        break

      default:
        break
    }

    if (text !== '') {
      this.progress(new Progress(progress, total, text))
    }
  }

  attachHandlers = () => {
    mark(`binary-handshake`)
    debug(`Attaching handlers`)
    this.device.on(DEVICE_EVENTS.DATA, this.receiveHandler)
    this._interval = setInterval(() => {
      this.loop(this.getNow())
    }, this._loopInterval)
  }

  detachHandlers = () => {
    measure(`binary-handshake`)
    debug(`Detaching handlers`)
    this.device.removeListener(DEVICE_EVENTS.DATA, this.receiveHandler)
    if (this._interval) {
      clearInterval(this._interval)
    }
  }

  connect = () => {
    debug(`Starting Handshake`)

    this.attachHandlers()

    // send initial request
    this.dispatch({ type: REQUEST })
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

  getIdentifier() {
    return 'electricui-binary-protocol-handshake' as const
  }
}
