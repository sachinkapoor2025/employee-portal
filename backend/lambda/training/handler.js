const { getUser } = require("../common/auth");
const { DynamoDBClient, QueryCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

// Hardcoded videos
const allVideos = [
  { id: '1', title: 'SEO Basics', profile: 'SEO', category: 'Basic', points: 0 },
  { id: '2', title: 'Advanced SEO', profile: 'SEO', category: 'Advanced', points: 10 },
  { id: '3', title: 'Web Design Intro', profile: 'Web Designer', category: 'Basic', points: 0 },
  { id: '4', title: 'Advanced Web Design', profile: 'Web Designer', category: 'Advanced', points: 10 },
  { id: '5', title: 'Web Development Basics', profile: 'Web Developer', category: 'Basic', points: 0 },
  { id: '6', title: 'Advanced Web Development', profile: 'Web Developer', category: 'Advanced', points: 10 },
  { id: '7', title: 'Cloud Fundamentals', profile: 'Cloud', category: 'Basic', points: 0 },
  { id: '8', title: 'Advanced Cloud', profile: 'Cloud', category: 'Advanced', points: 10 },
  { id: '9', title: 'Data Analysis Basics', profile: 'Data', category: 'Basic', points: 0 },
  { id: '10', title: 'Advanced Data Science', profile: 'Data', category: 'Advanced', points: 10 },
  { id: '11', title: 'AI Introduction', profile: 'AI', category: 'Basic', points: 0 },
  { id: '12', title: 'Advanced AI', profile: 'AI', category: 'Advanced', points: 10 },
  { id: '13', title: 'Engineering Principles', profile: 'Engineering', category: 'Basic', points: 0 },
  { id: '14', title: 'Advanced Engineering', profile: 'Engineering', category: 'Advanced', points: 10 },
  // Learning videos
  { id: '15', title: 'SEO Learning', profile: 'SEO', category: 'Learning', points: 0 },
  { id: '16', title: 'Web Design Learning', profile: 'Web Designer', category: 'Learning', points: 0 },
];

// Assume all users have all profiles for demo
const userProfiles = ['SEO', 'Web Designer', 'Web Developer', 'Cloud', 'Data', 'AI', 'Engineering'];

exports.handler = async (event) => {
  const user = getUser(event);
  const tableName = process.env.TRAINING_PROGRESS_TABLE;

  if (event.httpMethod === 'GET') {
    // Get videos for user profiles
    const userVideos = allVideos.filter(v => userProfiles.includes(v.profile));

    // Get progress
    const progress = {};
    for (const video of userVideos) {
      try {
        const params = {
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND SK = :sk",
          ExpressionAttributeValues: {
            ":pk": { S: user.email },
            ":sk": { S: video.id }
          }
        };
        const result = await client.send(new QueryCommand(params));
        if (result.Items.length > 0) {
          const item = result.Items[0];
          progress[video.id] = {
            status: item.status.S,
            points: item.points ? parseInt(item.points.N) : 0
          };
        }
      } catch (error) {
        console.error("Error fetching progress for video", video.id, error);
      }
    }

    const videosWithProgress = userVideos.map(v => ({
      ...v,
      status: progress[v.id]?.status || 'Not Started',
      points: progress[v.id]?.points || 0
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(videosWithProgress)
    };
  } else if (event.httpMethod === 'POST') {
    const { videoId, status, points } = JSON.parse(event.body);

    const params = {
      TableName: tableName,
      Item: {
        PK: { S: user.email },
        SK: { S: videoId },
        status: { S: status },
        ...(points && { points: { N: points.toString() } })
      }
    };
    await client.send(new PutItemCommand(params));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Progress updated" })
    };
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ error: "Method not allowed" })
  };
};
