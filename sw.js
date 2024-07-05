const DELAY_X_SHORT = 382;
const DELAY_SHORT = 618;
const DELAY_MED = 1000;
const DELAY_LONG = 1618;
const DELAY_X_LONG = 2618;

const streams = new Map();

onmessage = (event) => {
	const message = event.data;
	switch (message.command) {
		case 'port_to_url':
			{
				const originalOrigin = message.originalOrigin;
				const port = message.port;
				const suggestedName = message.suggestedName;

				let downloadURL;
				const readable = new ReadableStream({
					start: (controller) => {
						downloadURL = makeDownloadURL(suggestedName);
						port.onmessage = (event) => {
							const message = event.data;
							if ( !message.done ) {
								controller.enqueue(message.value);
							} else {
								if ( !message.error ) {
									controller.close();
								} else {
									controller.error(message.error);
								}
								port.close();
							}
						};
						port.postMessage({
							ok: true,
							value: downloadURL
						});
					},
					cancel: (reason) => {
						port.postMessage({
							error: `cancelled (${reason.toString()})`
						});
					}
				});
				streams.set(downloadURL, readableStream);

				setTimeout(() => {
					if ( streams.has(downloadURL) ) {
						console.warn("Dropping abandoned stream %o (requested by %s)", streams.get(downloadURL), originalOrigin);
						streams.delete(downloadURL);
					}
				}, DELAY_X_LONG);
			}
			break;
	}
}


onfetch = (event) => {
	const url = event.request.url;
	if ( streams.has(url) ) {
		const readableStream = streams.get(url);
		event.respondWith(new Response(readableStream, { headers: { 'Content-Disposition': 'attachment' } }));
		streams.delete(url);
	}
}


/* Utility Functions */

onerror = (event) => console.error(new Error(`${Object.getPrototypeOf(event.target).constructor.name}: ${error.type} event`, { cause: event }));


function makeDownloadURL(filename) {
	const u = new URL(location);
	{
		const p = u.pathname.split('/').slice(1);
		p.push(`;stream=${crypto.randomUUID()}`);
		if ( filename === undefined )
			filename = '';
		p.push(filename);
		u.pathname = p.join('/');
	}
	return u.toString();
}

