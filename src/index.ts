/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

// Default model for text-to-image generation
// https://developers.cloudflare.com/workers-ai/models/
const IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";

// Models users can pick from in the image tab
const IMAGE_MODELS = [
	"@cf/black-forest-labs/flux-2-klein-4b",
	"@cf/black-forest-labs/flux-2-klein-9b",
	"@cf/black-forest-labs/flux-1-schnell",
	"@cf/black-forest-labs/flux-2-dev",
] as const;

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname === "/api/image") {
			// Handle POST requests for image generation
			if (request.method === "POST") {
				return handleImageRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
				stream: true,
			},
			{
				// Uncomment to use AI Gateway
				// gateway: {
				//   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
				//   skipCache: false,      // Set to true to bypass cache
				//   cacheTtl: 3600,        // Cache time-to-live in seconds
				// },
			},
		);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Handles text-to-image API requests
 */
async function handleImageRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as {
			prompt?: string;
			model?: string;
			width?: number;
			height?: number;
		};

		const prompt = body.prompt?.trim();
		if (!prompt) {
			return Response.json(
				{ error: "Prompt is required" },
				{ status: 400 },
			);
		}

		const model = body.model ?? IMAGE_MODEL_ID;
		if (!IMAGE_MODELS.includes(model as (typeof IMAGE_MODELS)[number])) {
			return Response.json(
				{ error: "Unsupported image model" },
				{ status: 400 },
			);
		}

		const width = clampDimension(body.width ?? 1024);
		const height = clampDimension(body.height ?? 1024);

		// The published Worker types may not include the multipart input for newer
		// FLUX.2 image models yet, so call through a permissive signature.
		const run = env.AI.run as (model: string, input: unknown) => Promise<unknown>;

		let resp: unknown;
		if (model === "@cf/black-forest-labs/flux-1-schnell") {
			// FLUX.1 schnell takes a plain JSON input
			resp = await run(model, { prompt });
		} else {
			// FLUX.2 models require multipart form data, even for text-only prompts
			const form = new FormData();
			form.append("prompt", prompt);
			form.append("width", String(width));
			form.append("height", String(height));

			// FormData doesn't expose its serialized body or boundary. Passing it to a
			// Response constructor serializes it and generates the Content-Type header
			// with the boundary, which is required for the server to parse the multipart fields.
			const formResponse = new Response(form);
			resp = await run(model, {
				multipart: {
					body: formResponse.body,
					contentType: formResponse.headers.get("content-type"),
				},
			});
		}

		const { image, contentType } = resp as unknown as {
			image?: string;
			contentType?: string;
		};

		if (!image) {
			throw new Error("Image model returned an empty response");
		}

		return Response.json({ image, contentType });
	} catch (error) {
		console.error("Error processing image request:", error);
		return Response.json(
			{ error: "Failed to generate image" },
			{ status: 500 },
		);
	}
}

/**
 * Keeps image dimensions within the range supported by FLUX models.
 */
function clampDimension(value: number): number {
	return Math.min(1920, Math.max(256, Math.round(value)));
}
