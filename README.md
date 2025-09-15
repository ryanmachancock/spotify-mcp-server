## This is a local mcp server that can interact with your personal spotify account. 

You can talk to the LLM and have it perform actions such as 
>"Analyze my listening tastes and create a new workout playlist based on your findings"

Here is an example from the first go around:

<img width="774" height="1210" alt="image" src="https://github.com/user-attachments/assets/90472de5-4b4f-44a3-be51-145739007851" />
<img width="788" height="820" alt="image" src="https://github.com/user-attachments/assets/333078a1-0c56-44e3-be76-6746c9347349" />

and here is the playlist itself:

<img width="1708" height="1280" alt="image" src="https://github.com/user-attachments/assets/7b2394da-b391-42d2-bbd2-11c6f5b4d48c" />


So with just one small prompt in a brand new chat session, the LLM was able to analyze my personal listening preferences and create a curated playlist.
The best part is I didin't even have to open or interact with Spotify at all. The LLM can authenticate and perform actions on my behalf.

## Setup

1. Create a directory and copy the project files in. You can test through cli to make sure the python server starts up first.
2. Make sure you update the client id, client secret in your .env file.

In my case, I was using Claude Desktop, so I had to edit the mcp config file so that it could connect with the server.
This file is usually located a %APPDATA%\Roaming\Claude\claude_desktop_config.json

You can find examples of how this file should be set up online. Here is what it might look like:

```json
{
	"locale": "en-US",
	"userThemeMode": "system",
	"mcpServers": {
		"spotify": {
			"command": "C:\\Program Files\\nodejs\\node.exe",
			"args": [
				"C:\\Users\\Username\\path\\to\\index.js"
			],
			"env": {
				"SPOTIFY_CLIENT_ID": "your_client_id",
				"SPOTIFY_CLIENT_SECRET": "your_client_secret"
			}
		}
	}
}
```

Once your mcp is connected, you should have an indicator somewhere showing this. For example, in claude, you can see it from the tools menu. 
If you expand with the arrow, you can then see all of the specific spotify tools that the LLM has access to.

<img width="448" height="449" alt="image" src="https://github.com/user-attachments/assets/d1f97824-207e-4d76-b781-58766fd42482" />
