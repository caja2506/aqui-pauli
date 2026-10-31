import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const tilopayGetConfig = call('tilopayGetConfig');
export const tilopayGetQuote = call('tilopayGetQuote');
export const tilopayCreatePayment = call('tilopayCreatePayment');
export const tilopayConfirm = call('tilopayConfirm');
