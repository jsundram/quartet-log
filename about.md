# Data Visualization on the Go

| ![calendar.png](./calendar.png) | 
|:--:| 
| *A screenshot of a github-style [activity view](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/managing-contribution-settings-on-your-profile/showing-an-overview-of-your-activity-on-your-profile) made with this approach* |

I've been pretty interested in analyzing and visualizating data (professionally and as a hobby) for a while. When it comes to hobby projects, data sources are often hard to come by and are often one of:
1. Data scraped from the web using a purpose built scraper & parser. ([Daily Composers](https://daily-composers.netlify.app/) is an example of this.)
1. A very nice prepared data set someone else has painstakingly made. (like [The Pizza Dataset](https://github.com/amazon-science/pizza-semantic-parsing-dataset))
1. Data I enter myself.

For the third category, I discovered years ago that [Google Forms](https://docs.Google.com/forms/u/0/) is a great way of getting structured data into a spreadsheet (Google Sheets). In 2016, I started using this approach to log all the chamber music that I play (See [How To Make a Chamber Music Log](https://quip.com/0Fy0AQTJIQmd/How-to-Make-a-Chamber-Music-Log) for a detailed walkthrough).

I recently discovered that there is a magical setting hiding in Google Sheets. In the File Menu, under Share, there is a "Publish to Web" option, which allows you to access your spreadsheet data as CSV, JSON, and some other formats, at a given URL. This link is great because *it allows you to access an always up-to-date version of your data* without setting up the Google sheets api, and mucking around with OAuth, which is kind of painful. 

I've also enjoyed making static web pages for these data visualizations and experiments. They're great because they are easy to run locally on my laptop while developing (`python3 -m http.server` is my usual goto), easy to deploy by syncing to [Amazon's S3](https://medium.com/@kyle.galbraith/how-to-host-a-website-on-s3-without-getting-lost-in-the-sea-e2b82aa6cd38), and super cheap to host (most of my pages don't get that much traffic), with no headaches around maintaining backend infrastructure like databases, web servers, etc. The most annoying part of this, I have typically found, is getting a friendly name for your site (e.g. http://viz.runningwithdata.com/), but Google is your friend for this part. I haven't yet taken the step of making this work with https, which would be an additional headache, but probably very good for the future-proof-ness of the site. 

A great way to go one step further would be to use [dc.js ](https://dc-js.github.io/dc.js/) to build a simple interactive dashboard without the need for a backend. 

Combining all of the above, I have:
1. A Google form for logging data
2. A Google sheet where it is all stored, which is published to web.
3. A simple index.html file where I can pull the published data in a script tag, and use D3.js (or another javascript data visualization library) to visualize the data and make a small interactive tool.

Here's a very minimal old-school template (html/css/js all in one file!):
```javascript
<!DOCTYPE html>
<html lang="en">
<head>
    <title>📈</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Use CDN link to use less S3 bandwidth, or host on S3 for robustness.  -->
    <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
    <style>
        /* ChatGPT can be helpful for CSS... */
    </style>
</head>

<body>
    <script>
        const URL = "<YOUR URL HERE>"; // get this from File | Share | Publish to Web in Google Sheets

        function row(d){
            // do whatever cleanup / parsing / type coercion you want here.
            return {
                "timestamp": new Date(d.Timestamp),
                "location": d.Location.trim(),
                "comments": d.Comments.trim()
                "spacey": d["column title with spaces"].trim(),
            };
        }

        // https://devdocs.io/d3~7/d3-request#csv
        d3.csv(url, row).then(function(data) {
            // do additional data munging / filtering here, then 

            // call whatever functions you want to use to visualize your data.
            visualize(data);
        });
    </script>
</body>
</html>
```
