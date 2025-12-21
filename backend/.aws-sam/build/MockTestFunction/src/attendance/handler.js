const { getUser } = require("../common/auth");

exports.handler = async (event) => {
  const user = getUser(event);
  const body = JSON.parse(event.body);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Attendance recorded",
      user: user.email,
      data: body
    })
  };
};
