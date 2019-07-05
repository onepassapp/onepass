/* eslint-disable no-console */
import decodeJwt from 'jwt-decode';
import Router from 'next/router';
import cookie from 'js-cookie';

// Core Libraries
import {
    genRandomSalt,
    generateKeypair,
    encryptVaultKey,
    encryptPrivateKey,
    encryptSymmetricKey,
} from '@onepass/core/forge';
import { deriveClientSession, verifyLoginSession, genClientEphemeral, computeVerifier } from '@onepass/core/srp';
import { genCryptoRandomString, genMasterUnlockKey } from '@onepass/core/common';
import { stringToUint8Array, keyTobase64uri } from '@onepass/core/jseu';
import { normalizeMasterPassword } from '@onepass/core/nkdf';
import { computeHash } from '@onepass/core/pbkdf2';
import { computeHKDF } from '@onepass/core/hkdf';

import api from '../../../api';
import * as types from './types';
import * as endpoints from '../../../api/constants';

export const submitSignUpData = ({ email, name }) => {
    const lowerCaseEmail = email.toLowerCase();
    return async dispatch => {
        try {
            const { data } = await api({
                method: 'POST',
                url: endpoints.SIGNUP_SUBMIT_ENDPOINT,
                data: {
                    email: lowerCaseEmail,
                    name,
                },
            });
            dispatch({
                type: types.SUBMIT_SIGNUP_DATA,
                payload: data,
            });
            Router.push('/verify', '/signup/verify');
        } catch ({ response }) {
            // eslint-disable-next-line no-console
            console.log(response.data.error);
            // ToDo: Dispatch some error handler
        }
    };
};

export const submitVerificationToken = ({ email, verificationToken }) => {
    return async dispatch => {
        try {
            const response = await api({
                method: 'POST',
                url: endpoints.TOKEN_VERIFICATION_ENDPOINT,
                data: {
                    verificationToken,
                    email,
                },
            });
            dispatch({
                type: types.SUBMIT_VERIFICATION_TOKEN,
                payload: response.data,
            });
            Router.push('/masterpassword', '/signup/masterpassword');
        } catch ({ response }) {
            // eslint-disable-next-line no-console
            console.log(response.data.error);
            // ToDo: report invalid token
        }
    };
};

/**
 * Encryption Util funtions
 */

const deriveEncryptionKeySalt = ({ email, randomSalt }) => {
    const uint8Salt = stringToUint8Array(email);
    const uint8MasterSecret = stringToUint8Array(randomSalt);
    return computeHKDF({ uint8MasterSecret, uint8Salt });
};

// password key
const generateHashedKey = ({ normPassword, encryptionKeySalt }) => {
    const uint8MasterPassword = stringToUint8Array(normPassword);
    return computeHash({ uint8MasterPassword, encryptionKeySalt });
};

const generateSecretKey = ({ version, userId }) => {
    // get string after `user_`
    const trimmedUserId = userId.slice(5);
    const length = 34 - (version.length + trimmedUserId.length);
    const randomString = genCryptoRandomString(length);
    // generate 34 char secret key
    const secretKey = version.concat(trimmedUserId, randomString);
    return secretKey;
};

const deriveIntermediateKey = ({ secretKey, userId }) => {
    const uint8Salt = stringToUint8Array(userId);
    const uint8MasterSecret = stringToUint8Array(secretKey);
    return computeHKDF({ uint8MasterSecret, uint8Salt });
};

const generateSymmetricKey = () => {
    const key = genRandomSalt(32);
    const encodedSymmetricKey = stringToUint8Array(key);
    return keyTobase64uri(encodedSymmetricKey);
};

export const completeSignUp = ({ email, userId, version, password }) => {
    /**
     * SRP variables computing functions
     */
    const normPassword = normalizeMasterPassword(password);
    const { salt, verifier } = computeVerifier(userId, normPassword);

    const sendRequest = async data => {
        await api({
            method: 'POST',
            url: endpoints.VERIFIER_SUBMIT_ENDPOINT,
            data,
        });
    };

    // ToDo: all the pre-encryption computation
    return async dispatch => {
        try {
            /**
             * Encryption Variables
             */

            // 1. Generate Secret Key
            const secretKey = generateSecretKey({ version, userId });
            // 2. Compute MUK
            const randomSalt = genRandomSalt(16);
            const encryptionKeySalt = await deriveEncryptionKeySalt({ email, randomSalt });
            const hashedKey = await generateHashedKey({ normPassword, encryptionKeySalt });
            const intermediateKey = await deriveIntermediateKey({ secretKey, userId });
            const masterUnlockKey = genMasterUnlockKey({ hashedKey, intermediateKey });
            // ToDo: Return as JWK object
            const base64uriMasterUnlockKey = keyTobase64uri(masterUnlockKey);
            // 3. Create Encrypted Key Set
            const symmetricKey = generateSymmetricKey();
            const vaultKey = genCryptoRandomString(32);
            const { publicKey, privateKey } = await generateKeypair();
            const encryptedVaultKey = encryptVaultKey({ vaultKey, publicKey });
            const encryptedPrivateKeyInfo = encryptPrivateKey({ privateKey, symmetricKey });
            const { encryptedSymmetricKey, tag, iv } = encryptSymmetricKey({ symmetricKey, masterUnlockKey });

            await sendRequest({
                verifier,
                salt,
                email,
                userId,
            });
            dispatch({
                type: types.COMPLETE_SIGNUP,
            });
            Router.push('/login');
        } catch ({ response }) {
            // eslint-disable-next-line no-console
            console.log(response.data.error);
            // ToDo: report invalid token
        }
    };
};

export const submitLoginData = ({ email, password, secretKey }) => {
    const sendRequest = async data => {
        const response = await api({
            method: 'POST',
            url: endpoints.LOGIN_SUBMIT_ENDPOINT,
            data,
        });
        return response;
    };

    return async dispatch => {
        try {
            // get `salt` and `serverEphemeral.public` from server
            const {
                data: { userId, salt, serverPublicEphemeral },
            } = await sendRequest({ email, stage: 'init' });
            // Derive `clientEphemeral` pair
            const clientEphemeral = genClientEphemeral();
            dispatch({
                type: types.GET_SERVER_EPHEMERAL,
                payload: {
                    serverResponse: { userId, salt, serverPublicEphemeral },
                    clientEphemeral,
                },
            });
            // Derive the shared strong session key, and a proof
            const clientSecretEphemeral = clientEphemeral.secret;
            const clientSession = deriveClientSession(
                salt,
                userId,
                password,
                clientSecretEphemeral,
                serverPublicEphemeral
            );
            const clientPublicEphemeral = clientEphemeral.public;
            const clientSessionProof = clientSession.proof;
            // Send `clientSessionProof` & `clientPublicEphemeral` to the server
            const {
                data: { serverSessionProof, token },
            } = await sendRequest({
                email,
                clientPublicEphemeral,
                clientSessionProof,
                stage: 'login',
            });
            /**
             * Verify that the server has derived the correct strong session key
             */
            verifyLoginSession(clientPublicEphemeral, clientSession, serverSessionProof);

            const in1Hour = 1 / 24;
            cookie.set('token', token, { expires: in1Hour });

            dispatch({
                type: types.AUTH_USER,
                payload: decodeJwt(token),
            });

            Router.push('/vault');
        } catch (err) {
            // eslint-disable-next-line no-console
            console.log(err);
        }
    };
};

export const authUser = payload => {
    return dispatch => {
        dispatch({
            type: types.AUTH_USER,
            payload,
        });
    };
};

export const logoutUser = () => {
    return dispatch => {
        cookie.remove('token');
        dispatch({
            type: types.DE_AUTH_USER,
        });
        Router.push('/login');
    };
};

export const renewAuthUser = () => {
    return async (dispatch, getState) => {
        // ToDo: Check if renew is needed from state
        try {
            const {
                data: { token },
            } = await api({
                method: 'POST',
                headers: { Authorization: cookie.get('token') },
                url: endpoints.TOKEN_RENEWAL_ENDPOINT,
            });
            const in1Hour = 1 / 24;
            cookie.set('token', token, { expires: in1Hour });
            // ToDo: Dispatch renew action
            dispatch(authUser(decodeJwt(token)));
        } catch (error) {
            cookie.remove('token');
            // ToDo: Dispatch action to de-auth user
        }
    };
};
