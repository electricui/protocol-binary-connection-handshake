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
  RECEIVED_MESSAGEIDS = 'received-messageids',
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

    fullState.updateProgress(PROGRESS_KEYS.RECEIVED_MESSAGEIDS, {
      total: fullState.messageIDsReceived.length,
    })
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

    fullState.updateProgress(PROGRESS_KEYS.RECEIVED_MESSAGEID, {
      messageID: event.messageID,
    })
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

export const enum TRANSITIONS {
  START = 'START',
  TIMEOUT = 'TIMEOUT',
  RECEIVED_COUNT = 'RECEIVED_COUNT',
  RECEIVED_MESSAGEIDS = 'RECEIVED_MESSAGEIDS',
  RECEIVED_OBJECT = 'RECEIVED_OBJECT',
}

const stateMachine = Machine(
  {
    id: 'binary-handshake',
    initial: 'request_ids',
    key: 'handshake',
    states: {
      request_ids: {
        initial: 'await_list',
        states: {
          await_list: {
            on: {
              // As messageIDs come in, append them
              RECEIVED_MESSAGEIDS: {
                internal: true,
                actions: ['appendReceived'],
              },
              RECEIVED_COUNT: [
                {
                  // If we have received our messageIDs and the correct amount has been received, request the objects
                  cond: 'correctAmountOfMessageIDsRecevied',
                  target: '#handshake.request_objects_bulk',
                },
                {
                  // If we received the count but we haven't received the correct amount of messageIDs, wait for a timeout
                  internal: true,
                  cond: 'belowMaxRetries',
                },
                // If we are not below our maximum retries, fail out.
                { target: '#handshake.fail' },
              ],
              TIMEOUT: [
                {
                  // Retry if below our max retries
                  internal: true,
                  cond: 'belowMaxRetries',
                  actions: ['incrementRetries', 'requestList'],
                },
                // Otherwise fail out
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
              RECEIVED_OBJECT: [
                {
                  cond: 'allReceivedWhenThisAdded',
                  actions: ['addObject'],
                  target: '#handshake.finish',
                },
                {
                  actions: ['addObject'],
                  internal: true,
                },
              ],
              TIMEOUT: [
                {
                  internal: true,
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
              RECEIVED_OBJECT: [
                {
                  cond: 'allReceivedWhenThisAdded',
                  actions: ['addObject'],
                  target: '#handshake.finish',
                },
                {
                  cond: 'individualsLeftToRequest',
                  actions: ['addObject', 'requestIndividual'],
                  internal: true,
                },
              ],
              TIMEOUT: [
                {
                  internal: true,
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

          // If we have one missing that isn't the one we're about to add
          // we're not finished yet
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
  total?: number
}

export default class BinaryConnectionHandshake extends DeviceHandshake {
  currentState = stateMachine.initialState // starts as await_list
  fullState: FullStateShape

  private timeout: number = 1000
  private timeoutSince: number
  private interval: NodeJS.Timer | null = null
  private loopInterval: number = 50
  private lastProgress: number

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

    this.timeout = options.timeout ?? this.timeout
    this.lastProgress = this.getNow()
    this.timeoutSince = this.getNow()
  }

  onSubscribe() {
    this.connect()
  }

  getNow = () => {
    return new Date().getTime()
  }

  getLoopInterval = () => {
    return this.loopInterval
  }

  dispatch = (event: Event) => {
    debug(' > STATE TRANSITION', this.currentState.value)
    debug(' > EVENT', event)

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

    // Commit the transition to the next state
    this.currentState = nextState

    debug(' > TO', nextState.value)
    debug(' ^^^ ')
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

    this.complete()

    this.updateProgress(PROGRESS_KEYS.FINISHED)
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
          this.dispatch({ type: TRANSITIONS.RECEIVED_MESSAGEIDS, payload })
          this.timeoutSince = this.getNow()

          return
        case this.fullState.amountMessageID:
          this.fullState.numberOfMessageIDs = payload
          this.dispatch({ type: TRANSITIONS.RECEIVED_COUNT, payload })
          this.timeoutSince = this.getNow()

          this.updateProgress(PROGRESS_KEYS.RECEIVED_AMOUNT_OF_MESSAGEIDS, {
            total: payload,
          })

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
      // Do this in two steps
      this.dispatch({ type: TRANSITIONS.RECEIVED_OBJECT, messageID, payload })

      this.timeoutSince = this.getNow()
    }
  }

  updateProgress = (progressKey: PROGRESS_KEYS, meta: ProgressMeta = {}) => {
    const now = this.getNow()
    const diff = now - this.lastProgress

    let progress = Array.from(this.fullState.messageIDObjects.values()).filter(
      val => val !== undefined,
    ).length
    let total = this.fullState.numberOfMessageIDs

    let text = ''

    text = `+${diff}ms: ${JSON.stringify({ progressKey, meta })}`

    debug(
      `Progress Update +${diff}ms: ${JSON.stringify({ progressKey, meta })}`,
    )

    switch (progressKey) {
      case PROGRESS_KEYS.RECEIVED_MESSAGEID:
        break

      default:
        break
    }

    if (text !== '') {
      this.progress(new Progress(progress, total, text))
    }

    console.log(text)

    this.lastProgress = this.getNow()
  }

  attachHandlers = () => {
    mark(`binary-handshake`)
    debug(`Attaching handlers`)
    this.device.on(DEVICE_EVENTS.DATA, this.receiveHandler)
    this.interval = setInterval(() => {
      this.loop(this.getNow())
    }, this.loopInterval)
  }

  detachHandlers = () => {
    measure(`binary-handshake`)
    debug(`Detaching handlers`)
    this.device.removeListener(DEVICE_EVENTS.DATA, this.receiveHandler)
    if (this.interval) {
      clearInterval(this.interval)
    }
  }

  connect = () => {
    console.log('START')

    debug(`Starting Handshake`)

    this.attachHandlers()

    // send initial request
    actionMap.requestList(this.fullState, {
      type: TRANSITIONS.START 
    }, this.dispatch)
  }

  loop = (now: number) => {
    if (now - this.timeoutSince > this.timeout) {
      debug(`Timed out during:`, this.currentState.value)
      this.dispatch({ type: TRANSITIONS.TIMEOUT })
      this.timeoutSince = now
    }
  }

  onCancel() {
    this.detachHandlers()
  }

  getIdentifier() {
    return 'electricui-binary-protocol-handshake' as const
  }
}
