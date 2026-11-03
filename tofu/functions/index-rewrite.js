// CloudFront Function (viewer request, static behaviors only).
// S3 REST origins behind OAC don't serve directory indexes: map "/path/" to "/path/index.html".
// Free reports without a trailing slash are redirected to their canonical URL.
var FREE_REPORTS = ["/reports/near-users-vs-bots", "/reports/near-thesis"];

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (FREE_REPORTS.indexOf(uri) !== -1) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: uri + "/" } },
    };
  }

  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  }
  return request;
}
