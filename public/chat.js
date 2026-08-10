/**
 * Cloudflare AI Chat + Image Frontend
 *
 * Handles the chat UI, tab switching, and text-to-image generation.
 */

// ---------- DOM elements ----------
const chatContainer = document.getElementById("chat-container");
const imageContainer = document.getElementById("image-container");
const tabChat = document.getElementById("tab-chat");
const tabImage = document.getElementById("tab-image");

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

const imagePrompt = document.getElementById("image-prompt");
const imageModel = document.getElementById("image-model");
const imageSize = document.getElementById("image-size");
const generateButton = document.getElementById("generate-button");
const imageStatus = document.getElementById("image-status");
const imageResult = document.getElementById("image-result");
const generatedImage = document.getElementById("generated-image");
const downloadImage = document.getElementById("download-image");

const keyBar = document.getElementById("key-bar");
const apiKeyInput = document.getElementById("api-key-input");
const saveKeyButton = document.getElementById("save-key-button");

// ---------- API key (stored locally in the browser) ----------
let apiToken = localStorage.getItem("api_token") || "";

if (!apiToken) {
	keyBar.hidden = false;
}

saveKeyButton.addEventListener("click", () => {
	const value = apiKeyInput.value.trim();
	if (!value) return;
	apiToken = value;
	localStorage.setItem("api_token", value);
	keyBar.hidden = true;
	apiKeyInput.value = "";
});

function authHeaders(extra = {}) {
	const headers = { ...extra };
	if (apiToken) {
		headers["Authorization"] = `Bearer ${apiToken}`;
	}
	return headers;
}

// ---------- Tab switching ----------
tabChat.addEventListener("click", () => switchTab("chat"));
tabImage.addEventListener("click", () => switchTab("image"));

function switchTab(tab) {
	const isChat = tab === "chat";
	tabChat.classList.toggle("active", isChat);
	tabImage.classList.toggle("active", !isChat);
	chatContainer.hidden = !isChat;
	imageContainer.hidden = isChat;

	if (isChat) {
		userInput.focus();
	} else {
		imagePrompt.focus();
	}
}

// ---------- Chat state ----------
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];
let isProcessing = false;

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages
	if (message === "" || isProcessing) return;

	// Disable input while processing
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Show typing indicator
	typingIndicator.classList.add("visible");

	// Add message to history
	chatHistory.push({ role: "user", content: message });

	try {
		// Create new assistant response element
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<p></p>";
		chatMessages.appendChild(assistantMessageEl);
		const assistantTextEl = assistantMessageEl.querySelector("p");

		// Scroll to bottom
		chatMessages.scrollTop = chatMessages.scrollHeight;

		// Send request to API
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				messages: chatHistory,
			}),
		});

		// Handle errors
		if (!response.ok) {
			if (response.status === 401) {
				keyBar.hidden = false;
				throw new Error("未授权，请检查 API 密钥");
			}
			throw new Error("Failed to get response");
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Process streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";
		const flushAssistantText = () => {
			assistantTextEl.textContent = responseText;
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		let sawDone = false;
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Process any remaining complete events in buffer
				const parsed = consumeSseEvents(buffer + "\n\n");
				for (const data of parsed.events) {
					if (data === "[DONE]") {
						break;
					}
					try {
						const jsonData = JSON.parse(data);
						// Handle both Workers AI format (response) and OpenAI format (choices[0].delta.content)
						let content = "";
						if (
							typeof jsonData.response === "string" &&
							jsonData.response.length > 0
						) {
							content = jsonData.response;
						} else if (jsonData.choices?.[0]?.delta?.content) {
							content = jsonData.choices[0].delta.content;
						}
						if (content) {
							responseText += content;
							flushAssistantText();
						}
					} catch (e) {
						console.error("Error parsing SSE data as JSON:", e, data);
					}
				}
				break;
			}

			// Decode chunk
			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;
			for (const data of parsed.events) {
				if (data === "[DONE]") {
					sawDone = true;
					buffer = "";
					break;
				}
				try {
					const jsonData = JSON.parse(data);
					// Handle both Workers AI format (response) and OpenAI format (choices[0].delta.content)
					let content = "";
					if (
						typeof jsonData.response === "string" &&
						jsonData.response.length > 0
					) {
						content = jsonData.response;
					} else if (jsonData.choices?.[0]?.delta?.content) {
						content = jsonData.choices[0].delta.content;
					}
					if (content) {
						responseText += content;
						flushAssistantText();
					}
				} catch (e) {
					console.error("Error parsing SSE data as JSON:", e, data);
				}
			}
			if (sawDone) {
				break;
			}
		}

		// Add completed response to chat history
		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
		}
	} catch (error) {
		console.error("Error:", error);
		addMessageToChat(
			"assistant",
			"Sorry, there was an error processing your request.",
		);
	} finally {
		// Hide typing indicator
		typingIndicator.classList.remove("visible");

		// Re-enable input
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	messageEl.innerHTML = `<p>${content}</p>`;
	chatMessages.appendChild(messageEl);

	// Scroll to bottom
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}

// ---------- Image generation ----------
let isGenerating = false;

// Generate on button click or Enter (without Shift)
generateButton.addEventListener("click", generateImage);
imagePrompt.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		generateImage();
	}
});

/**
 * Sends a text-to-image request to the API and displays the result
 */
async function generateImage() {
	const prompt = imagePrompt.value.trim();

	// Don't generate empty prompts
	if (prompt === "" || isGenerating) return;

	isGenerating = true;
	generateButton.disabled = true;
	imageResult.hidden = true;
	imageStatus.textContent = "正在生成图片，通常需要几秒到几十秒...";

	try {
		const size = Number(imageSize.value);
		const response = await fetch("/api/image", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				prompt,
				model: imageModel.value,
				width: size,
				height: size,
			}),
		});

		const data = await response.json();
		if (!response.ok) {
			if (response.status === 401) {
				keyBar.hidden = false;
			}
			throw new Error(data.error || "Failed to generate image");
		}
		if (!data.image) {
			throw new Error("Model returned an empty image");
		}

		const contentType = data.contentType || "image/jpeg";
		const isPng = contentType.includes("png");
		generatedImage.src = `data:${contentType};base64,${data.image}`;
		downloadImage.href = generatedImage.src;
		downloadImage.download = `cloudflare-ai-${Date.now()}.${
			isPng ? "png" : "jpg"
		}`;
		imageResult.hidden = false;
		imageStatus.textContent = "";
	} catch (error) {
		console.error("Error:", error);
		imageStatus.textContent = "生成失败：" + error.message;
	} finally {
		isGenerating = false;
		generateButton.disabled = false;
	}
}
