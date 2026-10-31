import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { pilotProof } from './tilopayPilot';

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const tilopayGetConfig = () => call('tilopayGetConfig')(pilotProof());
export const tilopayGetQuote = call('tilopayGetQuote');
export const tilopayCreatePayment = (data) => call('tilopayCreatePayment')({ ...data, ...pilotProof() });
export const tilopayConfirm = call('tilopayConfirm');
