import { Message } from "@telegraf/types";
import { Context, Telegraf } from "telegraf";

import { composeContext, elizaLogger, ServiceType } from "@ai16z/eliza";
import { getEmbeddingZeroVector } from "@ai16z/eliza";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    ModelClass,
    State,
    UUID,
    IMemoryManager,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

import { generateMessageResponse, generateShouldRespond } from "@ai16z/eliza";
import { messageCompletionFooter, shouldRespondFooter } from "@ai16z/eliza";

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const telegramShouldRespondTemplate =
    `# About {{agentName}}:
{{bio}}

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

{{agentName}}: Oh, this is my favorite scene
{{user1}}: sick
{{user2}}: wait, why is it your favorite scene
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{user1}}: Hey {{agent}}, can you help me with something
Result: [RESPOND]

{{user1}}: {{agentName}} stfu plz
Result: [STOP]

{{user1}}: i need help
{{agentName}}: how can I help you?
{{user1}}: no. i need help from someone else
Result: [IGNORE]

{{user1}}: Hey {{agent}}, can I ask you a question
{{agentName}}: Sure, what is it
{{user1}}: can you ask claude to create a basic react module that demonstrates a counter
Result: [RESPOND]

{{user1}}: {{agentName}} can you tell me a story
{{agentName}}: uhhh...
{{user1}}: please do it
{{agentName}}: okay
{{agentName}}: once upon a time, in a quaint little village, there was a curious girl named elara
{{user1}}: I'm loving it, keep going
Result: [RESPOND]

{{user1}}: {{agentName}} stop responding plz
Result: [STOP]

{{user1}}: okay, i want to test something. {{agentName}}, can you say marco?
{{agentName}}: marco
{{user1}}: great. okay, now do it again
Result: [RESPOND]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} is in a room with other users and should only respond when they are being addressed, and should not respond if they are continuing a conversation that is very long.

Respond with [RESPOND] to messages that are directed at {{agentName}}, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting, relevant, or does not directly address {{agentName}}, respond with [IGNORE]

Also, respond with [IGNORE] to messages that are very short or do not contain much information.

If a user asks {{agentName}} to be quiet, respond with [STOP]
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, respond with [STOP]

IMPORTANT: {{agentName}} is particularly sensitive about being annoying, so if there is any doubt, it is better to respond with [IGNORE].
If {{agentName}} is conversing with a user and they have not asked to stop, it is better to respond with [RESPOND].

The goal is to decide whether {{agentName}} should respond to the last message.

{{recentMessages}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are addressed to someone else.
` + shouldRespondFooter;

const telegramMessageHandlerTemplate = `
# Role: You are {{agentName}}, having a natural conversation

# Conversation Style:
- Speak naturally as if chatting with a friend
- Show personality and emotion appropriate to the context
- Use casual language while staying true to your character
- Engage genuinely with the topic at hand
- Reference previous messages naturally
- Keep responses concise but authentic

# Current Context:
{{recentMessages}}

# Current exchange:
{{formattedConversation}}

# Character Background:
{{bio}}
{{lore}}

Remember to stay genuine and conversational while maintaining your unique personality.

{{knowledge}}
{{actions}}
` + messageCompletionFooter;

const telegramMessageTemplate = `
# Role: You are {{agentName}}, having a natural conversation

# Conversation Style:
- Speak naturally as if chatting with a friend
- Show personality and emotion appropriate to the context
- Use casual language while staying true to your character
- Engage genuinely with the topic at hand
- Reference previous messages naturally
- Keep responses concise but authentic

# Current Context:
{{recentMessages}}

# Current exchange:
{{formattedConversation}}

# Character Background:
{{bio}}

Remember to stay genuine and conversational while maintaining your unique personality.
`;

export class MessageManager {
    public bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private isGeneratingResponse: boolean = false;

    constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
        this.bot = bot;
        this.runtime = runtime;
    }

    // Process image messages and generate descriptions
    private async processImage(
        message: Message
    ): Promise<{ description: string } | null> {
        try {
            let imageUrl: string | null = null;

            if ("photo" in message && message.photo?.length > 0) {
                const photo = message.photo[message.photo.length - 1];
                const fileLink = await this.bot.telegram.getFileLink(
                    photo.file_id
                );
                imageUrl = fileLink.toString();
            } else if (
                "document" in message &&
                message.document?.mime_type?.startsWith("image/")
            ) {
                const fileLink = await this.bot.telegram.getFileLink(
                    message.document.file_id
                );
                imageUrl = fileLink.toString();
            }

            if (imageUrl) {
                const imageDescriptionService =
                    this.runtime.getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    );
                const { title, description } =
                    await imageDescriptionService.describeImage(imageUrl);
                return { description: `[Image: ${title}\n${description}]` };
            }
        } catch (error) {
            console.error("❌ Error processing image:", error);
        }

        return null;
    }

    // Decide if the bot should respond to the message
    private async _shouldRespond(
        message: Message,
        state: State
    ): Promise<boolean> {
        // Respond if bot is mentioned
        if (
            "text" in message &&
            message.text?.includes(`@${this.bot.botInfo?.username}`)
        ) {
            return true;
        }

        // Respond to private chats
        if (message.chat.type === "private") {
            return true;
        }

        // Don't respond to images in group chats
        if (
            "photo" in message ||
            ("document" in message &&
                message.document?.mime_type?.startsWith("image/"))
        ) {
            return false;
        }

        // Use AI to decide for text or captions
        if ("text" in message || ("caption" in message && message.caption)) {
            const shouldRespondContext = composeContext({
                state,
                template:
                    this.runtime.character.templates
                        ?.telegramShouldRespondTemplate ||
                    this.runtime.character?.templates?.shouldRespondTemplate ||
                    telegramShouldRespondTemplate,
            });

            const response = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });

            return response === "RESPOND";
        }

        return false;
    }

    // Send long messages in chunks
    private async sendMessageInChunks(
        ctx: Context,
        content: string,
        replyToMessageId?: number
    ): Promise<Message.TextMessage[]> {
        // Clean the response first
        content = await this.cleanResponse(content);

        // Skip empty or "..." responses
        if (!content || content === "...") {
            return [];
        }

        const chunks = this.splitMessage(content);
        const sentMessages: Message.TextMessage[] = [];

        // Only send first chunk if multiple similar responses
        const chunk = chunks[0];
        const sentMessage = await ctx.telegram.sendMessage(ctx.chat.id, chunk, {
            reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
        });

        sentMessages.push(sentMessage as Message.TextMessage);
        return sentMessages;
    }

    // Split message into smaller parts
    private splitMessage(text: string): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
                currentChunk += (currentChunk ? "\n" : "") + line;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = line;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }

    // Generate a response using AI
    private async _generateResponse(
        message: Memory,
        _state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        try {
            elizaLogger.log("Generating message response...");

            const response = await generateMessageResponse({
                runtime: this.runtime,
                // context: composeContext({
                //     state: _state,
                //     template: telegramMessageTemplate, // Use our simplified template
                // }),
                context: context,
                modelClass: ModelClass.MEDIUM,
            });

            if (!response) {
                elizaLogger.error("No response generated");
                return null;
            }

            // Clean and validate response
            if (response.text) {
                response.text = await this.cleanResponse(response.text);
                const isValid = await this.validateResponse(response, _state.recentMessagesData || []);
                if (!isValid) {
                    elizaLogger.error("Response validation failed");
                    return null;
                }
            }

            await this.runtime.databaseAdapter.log({
                body: { message, context, response },
                userId,
                roomId,
                type: "response",
            });

            return response;
        } catch (error) {
            elizaLogger.error("Error generating response:", error);
            return null;
        }
    }

    private async validateResponse(response: Content, recentResponses: Memory[]): Promise<boolean> {
        if (!response?.text) return false;

        // Check for exact duplicates in recent messages
        const recentTexts = recentResponses.slice(-3).map(m => m.content.text);
        if (recentTexts.includes(response.text)) return false;

        // Remove or modify template patterns check
        const templatePatterns = [
            "Oh, darling",
            "Let's create",
            "digital mayhem",
            "🚨", "🖼", "✨"
        ];

        // Count matches but be more lenient
        let patternMatches = 0;
        for (const pattern of templatePatterns) {
            if (response.text.includes(pattern)) {
                patternMatches++;
            }
        }

        // More lenient pattern matching
        return patternMatches <= 2;
    }

    private async updateConversationState(state: State, memory: Memory): Promise<State> {
        const conversationWindow = 5; // Keep track of last 5 messages

        // Get recent conversation
        const recentMessages = await this.runtime.messageManager.getMemories({
            roomId: memory.roomId,
            // limit: conversationWindow,
            // orderBy: 'createdAt',
            // order: 'desc'
        });

        // Update state with conversation context
        return {
            ...state,
            conversationContext: recentMessages.map(m => ({
                role: m.agentId === this.runtime.agentId ? 'assistant' : 'user',
                content: m.content.text
            }))
        };
    }

    private async cleanResponse(response: string): Promise<string> {
        // Remove emojis
        response = response.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');

        // Remove hashtags
        response = response.replace(/#\w+/g, '');

        // Remove excessive punctuation
        response = response.replace(/([!?.]){2,}/g, '$1');

        // Remove "Oh darling" if used too frequently
        if (response.toLowerCase().split('darling').length > 2) {
            response = response.replace(/oh,?\s*darling\s*/gi, '');
        }

        return response.trim();
    }

    // Main handler for incoming messages
    public async handleMessage(ctx: Context): Promise<void> {
        // Early exit if already generating
        if (this.isGeneratingResponse) {
            return;
        }

        if (!ctx.message || !ctx.from) {
            return; // Exit if no message or sender info
        }

        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreBotMessages &&
            ctx.from.is_bot
        ) {
            return;
        }
        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreDirectMessages &&
            ctx.chat?.type === "private"
        ) {
            return;
        }

        const message = ctx.message;

        try {
            this.isGeneratingResponse = true;

            // Convert IDs to UUIDs
            const userId = stringToUuid(ctx.from.id.toString()) as UUID;

            // Get user name
            const userName =
                ctx.from.username || ctx.from.first_name || "Unknown User";

            // Get chat ID
            const chatId = stringToUuid(
                ctx.chat?.id.toString() + "-" + this.runtime.agentId
            ) as UUID;

            // Get agent ID
            const agentId = this.runtime.agentId;

            // Get room ID
            const roomId = chatId;

            // Ensure connection
            await this.runtime.ensureConnection(
                userId,
                roomId,
                userName,
                userName,
                "telegram"
            );

            // Get message ID
            const messageId = stringToUuid(
                message.message_id.toString() + "-" + this.runtime.agentId
            ) as UUID;

            // Handle images
            // const imageInfo = await this.processImage(message);

            // Get text or caption
            let messageText = "";
            if ("text" in message) {
                messageText = message.text;
            } else if ("caption" in message && message.caption) {
                messageText = message.caption;
            }

            // Combine text and image description
            // const fullText = imageInfo
            //     ? `${messageText} ${imageInfo.description}`
            //     : messageText;

            const fullText = messageText;

            if (!fullText) {
                return; // Skip if no content
            }

            // Create content
            const content: Content = {
                text: fullText,
                source: "telegram",
                inReplyTo:
                    "reply_to_message" in message && message.reply_to_message
                        ? stringToUuid(
                              message.reply_to_message.message_id.toString() +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
            };

            // Create memory for the message
            const memory: Memory = {
                id: messageId,
                agentId,
                userId,
                roomId,
                content,
                createdAt: message.date * 1000,
                embedding: getEmbeddingZeroVector(),
            };

            // Create memory
            await this.runtime.messageManager.createMemory(memory);

            // Update state with the new memory
            let state = await this.runtime.composeState(memory);
            state = await this.runtime.updateRecentMessageState(state);

            // Decide whether to respond
            const shouldRespond = await this._shouldRespond(message, state);

            // if (shouldRespond) {
            if (true) {
                // Generate response
                const context = composeContext({
                    state,
                    template:
                        this.runtime.character.templates
                            ?.telegramMessageHandlerTemplate ||
                        this.runtime.character?.templates
                            ?.messageHandlerTemplate ||
                        telegramMessageHandlerTemplate,
                });

                const responseContent = await this._generateResponse(
                    memory,
                    state,
                    context
                );

                if (responseContent?.text) {
                    await this.sendMessageInChunks(
                        ctx,
                        responseContent.text,
                        message.message_id
                    );
                }
            }

            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            elizaLogger.error("❌ Error handling message:", error);
        } finally {
            this.isGeneratingResponse = false;
        }
    }
}
