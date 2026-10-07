import { BankExchangeError } from './bankExchangeError.js';
import { base64ToBinary, binaryToBase64 } from './bytes.js';
import { type CustomerMessage, type CustomerOrderMessage, Message } from './message.js';

export class HttpClient {
	constructor(
		public url: string,
		public debug = false,
		public debugRaw = false,
	) {}

	async sendMessage(message: CustomerMessage): Promise<Message> {
		const encodedMessage = message.encode();

		if (this.debug) {
			console.log('Request Message:\n');

			if (this.debugRaw) {
				console.log(encodedMessage.split("'").join('\n'));
			} else {
				console.log(message.toString());
			}
		}

		let response: Response;
		let responseText: string;

		try {
			response = await fetch(this.url, {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: binaryToBase64(encodedMessage),
			});
			responseText = response.ok ? base64ToBinary(await response.text()) : '';
		} catch (cause) {
			throw new BankExchangeError('The bank could not be reached', 'connection', { cause });
		}

		if (response.ok) {
			try {
				const customerOrderMessage = message as CustomerOrderMessage;
				const responseMessage = Message.decode(
					responseText,
					customerOrderMessage.supportsPartedResponseSegments
						? customerOrderMessage.orderResponseSegId
						: undefined,
				);
				if (this.debug) {
					console.log('Response Message:\n');

					if (this.debugRaw) {
						console.log(responseText.split("'").join('\n'));
					} else {
						console.log(`Response Message:\n${responseMessage.toString(true)}\n`);
					}
				}
				return responseMessage;
			} catch (error) {
				console.error('Error decoding response message:', error);
				console.error('Response Message Content:\n', responseText.split("'").join('\n'));
				throw new BankExchangeError('The answer of the bank could not be read', 'answer', {
					cause: error,
				});
			}
		} else {
			throw new BankExchangeError(
				`Request failed with status code ${response.status}`,
				'connection',
			);
		}
	}
}
