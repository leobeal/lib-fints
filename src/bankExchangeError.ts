/**
 * A message was handed to the network and the exchange did not complete.
 *
 * It is the one error after which the caller cannot know what the bank did: the
 * message may never have arrived, or the bank may have carried it out and only its
 * answer was lost. For an order that moves money that difference is everything, so
 * it must not be retried as if nothing had happened.
 *
 * Every other error this library throws is thrown before anything was sent.
 */
export class BankExchangeError extends Error {
	/**
	 * @param stage `connection`: the bank was not reached, or did not answer with a
	 * FinTS message. `answer`: the bank answered and the answer could not be read.
	 */
	constructor(
		message: string,
		public readonly stage: 'connection' | 'answer',
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'BankExchangeError';
	}
}
