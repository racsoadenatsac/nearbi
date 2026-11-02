// CloudFront Function (viewer request, static behaviors only).
// S3 REST origins behind OAC don't serve directory indexes: map "/path/" to "/path/index.html".
// The free sample without a trailing slash is redirected to the canonical URL.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === "/reports/near-users-vs-bots") {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: "/reports/near-users-vs-bots/" } },
    };
  }

  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  }
  return request;
}
