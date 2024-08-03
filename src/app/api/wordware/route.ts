import { getUser, updateUser } from '@/actions/actions'

/**
 * Maximum duration for the API route execution (in seconds)
 */
export const maxDuration = 300

type TweetType = {
  isRetweet: boolean
  author: { userName: string }
  createdAt: string
  text: string
  retweetCount: number
  replyCount: number
  likeCount: number
  quoteCount: number
  viewCount: number
}

/**
 * POST handler for the Wordware API route
 * @param {Request} request - The incoming request object
 * @returns {Promise<Response>} The response object
 */
export async function POST(request: Request) {
  // Extract username from the request body
  const { username } = await request.json()

  // Fetch user data and check if Wordware has already been started
  const user = await getUser({ username })

  if (!user) {
    throw Error(`User not found: ${username}`)
  }

  if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
    return Response.json({ error: 'Wordware already started' })
  }

  function formatTweet(tweet: TweetType) {
    // console.log('Formatting', tweet)
    const isRetweet = tweet.isRetweet ? 'RT ' : ''
    const author = tweet.author?.userName ?? username
    const createdAt = tweet.createdAt
    const text = tweet.text
      .split('\n')
      .map((line) => `${line}`)
      .join(`\n> `)
    return `**${isRetweet}@${author} - ${createdAt}**

> ${text}

*retweets: ${tweet.retweetCount}, replies: ${tweet.replyCount}, likes: ${tweet.likeCount}, quotes: ${tweet.quoteCount}, views: ${tweet.viewCount}*`
  }

  const tweets = user.tweets as TweetType[]

  // console.log('Tweets', tweets)

  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  console.log('Tweets markdown', tweetsMarkdown)

  // Make a request to the Wordware API
  const runResponse = await fetch(`https://app.wordware.ai/api/released-app/${process.env.WORDWARE_PROMPT_ID}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: {
        tweets: `Tweets: ${tweetsMarkdown}`,
        profilePicture: user.profilePicture,
        profileInfo: user.fullProfile,
        version: '^1.0',
      },
    }),
  })

  // console.log('🟣 | file: route.ts:40 | POST | runResponse:', runResponse)
  // Get the reader from the response body
  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    // console.error('No reader')
    console.log('🟣 | ERROR | file: route.ts:40 | POST | runResponse:', runResponse)
    return Response.json({ error: 'No reader' }, { status: 400 })
  }

  // Update user to indicate Wordware has started
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  // Set up decoder and buffer for processing the stream
  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false

  // Create a readable stream to process the response
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          // console.log('🟣 | file: route.ts:80 | start | chunk:', chunk)

          // Process the chunk character by character
          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()

            // Parse the JSON content of each line
            const content = JSON.parse(line)
            const value = content.value

            // Handle different types of messages in the stream
            if (value.type === 'generation') {
              if (value.state === 'start') {
                if (value.label === 'output') {
                  finalOutput = true
                }
                // console.log('\nNEW GENERATION -', value.label)
              } else {
                if (value.label === 'output') {
                  finalOutput = false
                }
                // console.log('\nEND GENERATION -', value.label)
              }
            } else if (value.type === 'chunk') {
              if (finalOutput) {
                controller.enqueue(value.value ?? '')
              }
            } else if (value.type === 'outputs') {
              console.log('✨ here:', value.values.output, '. Now parsing')
              try {
                // Update user with the analysis from Wordware
                await updateUser({
                  user: {
                    ...user,
                    wordwareStarted: true,
                    wordwareCompleted: true,
                    analysis: value.values.output,
                  },
                })
                // console.log('Analysis saved to database')
              } catch (error) {
                console.error('Error parsing or saving output:', error)
                // Reset wordwareStarted if there's an error
                await updateUser({
                  user: {
                    ...user,
                    wordwareStarted: false,
                  },
                })
              }
            }

            // Reset buffer for the next line
            buffer = []
          }
        }
      } finally {
        // Ensure the reader is released when done
        reader.releaseLock()
      }
    },
  })

  // Return the stream as the response
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
