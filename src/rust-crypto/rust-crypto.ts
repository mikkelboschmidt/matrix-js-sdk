/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-js";

import type { IEventDecryptionResult, IMegolmSessionData } from "../@types/crypto";
import type { IToDeviceEvent } from "../sync-accumulator";
import type { IEncryptedEventInfo } from "../crypto/api";
import { MatrixEvent } from "../models/event";
import { CryptoBackend, OnSyncCompletedData } from "../common-crypto/CryptoBackend";
import { logger } from "../logger";
import { IHttpOpts, MatrixHttpApi } from "../http-api";
import { DeviceTrustLevel, UserTrustLevel } from "../crypto/CrossSigning";
import { OutgoingRequest, OutgoingRequestProcessor } from "./OutgoingRequestProcessor";

/**
 * An implementation of {@link CryptoBackend} using the Rust matrix-sdk-crypto.
 */
export class RustCrypto implements CryptoBackend {
    public globalBlacklistUnverifiedDevices = false;
    public globalErrorOnUnknownDevices = false;

    /** whether {@link stop} has been called */
    private stopped = false;

    /** whether {@link outgoingRequestLoop} is currently running */
    private outgoingRequestLoopRunning = false;

    private outgoingRequestProcessor: OutgoingRequestProcessor;

    public constructor(
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,
        http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        _userId: string,
        _deviceId: string,
    ) {
        this.outgoingRequestProcessor = new OutgoingRequestProcessor(olmMachine, http);
    }

    public stop(): void {
        // stop() may be called multiple times, but attempting to close() the OlmMachine twice
        // will cause an error.
        if (this.stopped) {
            return;
        }
        this.stopped = true;

        // make sure we close() the OlmMachine; doing so means that all the Rust objects will be
        // cleaned up; in particular, the indexeddb connections will be closed, which means they
        // can then be deleted.
        this.olmMachine.close();
    }

    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const res = (await this.olmMachine.decryptRoomEvent(
            JSON.stringify({
                event_id: event.getId(),
                type: event.getWireType(),
                sender: event.getSender(),
                state_key: event.getStateKey(),
                content: event.getWireContent(),
                origin_server_ts: event.getTs(),
            }),
            new RustSdkCryptoJs.RoomId(event.getRoomId()!),
        )) as RustSdkCryptoJs.DecryptedRoomEvent;
        return {
            clearEvent: JSON.parse(res.event),
            claimedEd25519Key: res.senderClaimedEd25519Key,
            senderCurve25519Key: res.senderCurve25519Key,
            forwardingCurve25519KeyChain: res.forwardingCurve25519KeyChain,
        };
    }

    public getEventEncryptionInfo(event: MatrixEvent): IEncryptedEventInfo {
        // TODO: make this work properly. Or better, replace it.

        const ret: Partial<IEncryptedEventInfo> = {};

        ret.senderKey = event.getSenderKey() ?? undefined;
        ret.algorithm = event.getWireContent().algorithm;

        if (!ret.senderKey || !ret.algorithm) {
            ret.encrypted = false;
            return ret as IEncryptedEventInfo;
        }
        ret.encrypted = true;
        ret.authenticated = true;
        ret.mismatchedSender = true;
        return ret as IEncryptedEventInfo;
    }

    public async userHasCrossSigningKeys(): Promise<boolean> {
        // TODO
        return false;
    }

    public async exportRoomKeys(): Promise<IMegolmSessionData[]> {
        // TODO
        return [];
    }

    public checkUserTrust(userId: string): UserTrustLevel {
        // TODO
        return new UserTrustLevel(false, false, false);
    }

    public checkDeviceTrust(userId: string, deviceId: string): DeviceTrustLevel {
        // TODO
        return new DeviceTrustLevel(false, false, false, false);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // SyncCryptoCallbacks implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /** called by the sync loop to preprocess incoming to-device messages
     *
     * @param events - the received to-device messages
     * @returns A list of preprocessed to-device messages.
     */
    public async preprocessToDeviceMessages(events: IToDeviceEvent[]): Promise<IToDeviceEvent[]> {
        // send the received to-device messages into receiveSyncChanges. We have no info on device-list changes,
        // one-time-keys, or fallback keys, so just pass empty data.
        const result = await this.olmMachine.receiveSyncChanges(
            JSON.stringify(events),
            new RustSdkCryptoJs.DeviceLists(),
            new Map(),
            new Set(),
        );

        // receiveSyncChanges returns a JSON-encoded list of decrypted to-device messages.
        return JSON.parse(result);
    }

    /** called by the sync loop after processing each sync.
     *
     * TODO: figure out something equivalent for sliding sync.
     *
     * @param syncState - information on the completed sync.
     */
    public onSyncCompleted(syncState: OnSyncCompletedData): void {
        // Processing the /sync may have produced new outgoing requests which need sending, so kick off the outgoing
        // request loop, if it's not already running.
        this.outgoingRequestLoop();
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Outgoing requests
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private async outgoingRequestLoop(): Promise<void> {
        if (this.outgoingRequestLoopRunning) {
            return;
        }
        this.outgoingRequestLoopRunning = true;
        try {
            while (!this.stopped) {
                const outgoingRequests: Object[] = await this.olmMachine.outgoingRequests();
                if (outgoingRequests.length == 0 || this.stopped) {
                    // no more messages to send (or we have been told to stop): exit the loop
                    return;
                }
                for (const msg of outgoingRequests) {
                    await this.outgoingRequestProcessor.makeOutgoingRequest(msg as OutgoingRequest);
                }
            }
        } catch (e) {
            logger.error("Error processing outgoing-message requests from rust crypto-sdk", e);
        } finally {
            this.outgoingRequestLoopRunning = false;
        }
    }
}
