import type { BankTransaction } from './bankTransaction.js';
import type { Language } from './codes.js';
import type { TanMethod } from './tanMethod.js';

export type BPD = {
	version: number;
	countryCode: number;
	bankId: string;
	bankName: string;
	maxTransactionsPerMessage: number;
	supportedLanguages: Language[];
	supportedHbciVersions: number[];
	/** Largest message the bank accepts, in kilobytes; absent or 0 when it names no limit. */
	maxMessageSizeInKb?: number;
	/** The shortest and longest time, in seconds, the bank announces for a dialog left idle; absent when it names none. */
	minTimeoutSecs?: number;
	maxTimeoutSecs?: number;
	url?: string;
	supportedTanMethods: TanMethod[];
	availableTanMethodIds: number[];
	allowedTransactions: BankTransaction[];
};
