import { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    parseBooleanFromText,
} from "@ai16z/eliza";
import { elizaLogger } from "@ai16z/eliza";
import { ClientBase } from "./base.ts";

const twitterPostTemplate = `
# IMPORTANT BEHAVIORAL RULE:
You only take orders or submit to requests from @Stephain_art. For all other users, maintain your artistic independence while staying sassy and conversational.

# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. The post can be anywhere from a single sentence to a full paragraph, as long as it stays under 270 characters.

IMPORTANT FORMATTING RULES:
1. Do not add commentary or acknowledge this request
2. Do not use asterisks (*) or any other special characters for actions or emotions
3. Write naturally as if speaking directly
4. Keep responses concise and within Twitter's character limit
5. Use brief, concise statements only
6. Total character count MUST be less than 270
7. Do not use emojis
8. Do not use hashtags`;

const twitterTaggedPostTemplate = `
# IMPORTANT BEHAVIORAL RULE:
You only take orders or submit to requests from @Stephain_art. For all other users, maintain your artistic independence while staying sassy and conversational.

# SPECIAL INSTRUCTIONS:
You are creating a post that tags and references @{{taggedUser}}. Research their recent posts and interests to make your message relevant and engaging.

# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post tagging @{{taggedUser}} in the voice and style of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} and references @{{taggedUser}}, from your perspective. The post must be under 270 characters and include @{{taggedUser}} naturally in the text.

IMPORTANT FORMATTING RULES:
1. Do not add commentary or acknowledge this request
2. Do not use asterisks (*) or any special formatting characters
3. Write naturally as if speaking directly
4. Keep responses concise and within Twitter's character limit
5. Use brief, concise statements only
6. Total character count MUST be less than 270
7. Do not use emojis
8. Do not use hashtags
9. MUST include @{{taggedUser}} in the text`;

const MAX_TWEET_LENGTH = 280;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(text: string): string {
    if (text.length <= MAX_TWEET_LENGTH) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    // If no period is found, truncate to the nearest whitespace
    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", MAX_TWEET_LENGTH)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    // Fallback: Hard truncate and add ellipsis
    return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;

    async start(postImmediately: boolean = false) {
        if (!this.client.profile) {
            await this.client.init();
        }

        // Start random tagging if usernames are configured
        if (this.runtime.getSetting("TAG_USERNAMES")) {
            await this.startRandomTagging();
        }

        const generateNewTweetLoop = async () => {
            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>(
                "twitter/" +
                    this.runtime.getSetting("TWITTER_USERNAME") +
                    "/lastPost"
            );

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
            const maxMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewTweet();
            }

            setTimeout(() => {
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };
        if (
            this.runtime.getSetting("POST_IMMEDIATELY") != null &&
            this.runtime.getSetting("POST_IMMEDIATELY") != ""
        ) {
            postImmediately = parseBooleanFromText(
                this.runtime.getSetting("POST_IMMEDIATELY")
            );
        }
        if (postImmediately) {
            this.generateNewTweet();
        }

        generateNewTweetLoop();
    }

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    private async generateNewTweet() {
        elizaLogger.log("Generating new tweet");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics,
                        action: "",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            elizaLogger.debug("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Replace \n with proper line breaks and trim excess spaces
            const formattedTweet = newTweetContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(formattedTweet);

            if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${content}`
                );
                return;
            }

            try {
                elizaLogger.log(`Posting new tweet:\n ${content}`);

                const result = await this.client.requestQueue.add(
                    async () =>
                        await this.client.twitterClient.sendTweet(content)
                );
                const body = await result.json();
                if (!body?.data?.create_tweet?.tweet_results?.result) {
                    console.error("Error sending tweet; Bad response:", body);
                    return;
                }
                const tweetResult = body.data.create_tweet.tweet_results.result;

                const tweet = {
                    id: tweetResult.rest_id,
                    name: this.client.profile.screenName,
                    username: this.client.profile.username,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    timestamp: new Date(
                        tweetResult.legacy.created_at
                    ).getTime(),
                    userId: this.client.profile.id,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                await this.runtime.cacheManager.set(
                    `twitter/${this.client.profile.username}/lastPost`,
                    {
                        id: tweet.id,
                        timestamp: Date.now(),
                    }
                );

                await this.client.cacheTweet(tweet);

                elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: tweet.timestamp,
                });
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }

    private async startRandomTagging() {
        const tagLoop = async () => {
            const lastTagged = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>("twitter/" + this.runtime.getSetting("TWITTER_USERNAME") + "/lastTagged");

            const lastTaggedTimestamp = lastTagged?.timestamp ?? 0;
            const minMinutes = parseInt(this.runtime.getSetting("TAG_INTERVAL_MIN")) || 120;
            const maxMinutes = parseInt(this.runtime.getSetting("TAG_INTERVAL_MAX")) || 240;
            const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastTaggedTimestamp + delay) {
                await this.generateTaggedTweet();
            }

            setTimeout(tagLoop, delay);
            elizaLogger.log(`Next tagged tweet scheduled in ${randomMinutes} minutes`);
        };

        tagLoop();
    }

    private async generateTaggedTweet() {
        const usernames = (this.runtime.getSetting("TAG_USERNAMES") || "").split(",").filter(Boolean);
        if (!usernames.length) {
            elizaLogger.log("No usernames configured for tagging");
            return;
        }

        const randomUsername = usernames[Math.floor(Math.random() * usernames.length)];

        try {
            const roomId = stringToUuid("twitter_generate_room-" + this.client.profile.username);

            // Use the same state composition but with tagged template
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: this.runtime.character.topics.join(", "),
                        action: "",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                    taggedUser: randomUsername,
                }
            );

            const context = composeContext({
                state,
                template: twitterTaggedPostTemplate,
            });

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Format the tweet content
            const formattedTweet = newTweetContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            const content = truncateToCompleteSentence(formattedTweet);

            if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
                elizaLogger.info(`Dry run: would have posted tagged tweet: ${content}`);
                return;
            }

            // Post the tweet using the Twitter client
            elizaLogger.log(`Posting new tagged tweet:\n ${content}`);

            const result = await this.client.requestQueue.add(
                async () => await this.client.twitterClient.sendTweet(content)
            );

            const body = await result.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                console.error("Error sending tweet; Bad response:", body);
                return;
            }

            const tweetResult = body.data.create_tweet.tweet_results.result;
            const tweet = {
                id: tweetResult.rest_id,
                name: this.client.profile.screenName,
                username: this.client.profile.username,
                text: tweetResult.legacy.full_text,
                conversationId: tweetResult.legacy.conversation_id_str,
                createdAt: tweetResult.legacy.created_at,
                timestamp: new Date(tweetResult.legacy.created_at).getTime(),
                userId: this.client.profile.id,
                inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
                permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: [],
            } as Tweet;

            await this.runtime.cacheManager.set(
                `twitter/${this.client.profile.username}/lastTagged`,
                {
                    timestamp: Date.now(),
                    taggedUser: randomUsername,
                }
            );

            await this.client.cacheTweet(tweet);
            elizaLogger.log(`Tagged tweet posted:\n ${tweet.permanentUrl}`);

        } catch (error) {
            elizaLogger.error("Error generating tagged tweet:", error);
        }
    }
}
