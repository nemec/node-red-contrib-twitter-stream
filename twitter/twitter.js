const http = require('http');
const HttpsProxyAgent = require('https-proxy-agent');
const url = require('url');

module.exports = function(RED) {
    "use strict";
    const util = require('util');
    const Twit = require('twit');
    const between = require('between-range');

    var clients = {};

    // handle the connection to the Twitter API
    function TwitterAPIConnection(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        
        var id = n.connectionName;
        node.log('create new Twitter instance for: ' + id);

        clients[id] = new Twit({
            consumer_key: node.credentials.consumerKey,
            consumer_secret: node.credentials.consumerSecret,
            access_token: node.credentials.accessToken,
            access_token_secret: node.credentials.accessSecret
        });

        node.client = clients[id];

        this.on("close", function() {
            node.log('delete Twitter instance on close event');
            delete clients[id];
        });
    }

    RED.nodes.registerType("twitter-api-connection",TwitterAPIConnection,{
        credentials: {
            consumerKey: {type: "password"},
            consumerSecret: {type: "password"},
            accessToken: {type: "password"},
            accessSecret: {type:"password"}
        }
    });

    function TwitterListStream(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        node.listId = n.listId || "";
        node.triggerOnStartup = n.triggerOnStartup || false;
        node.tweetLimit = parseInt(n.tweetLimit) || 0;
        node.includeRetweets = n.includeRetweets || false;
        node.loadMedia = n.loadMedia || false;
        node.debug = n.debug || false;
        node.streamOptions = {};
        node.tweetCount = 0;
        node.connection = RED.nodes.getNode(n.connection);
        node.status({fill:"yellow",shape:"dot",text:"connecting"});

        var nodeContext = this.context();

        let maxId = nodeContext.get('twitter_list_stream_max_id') || 0;
        let startup = true;

        if (maxId !== 0) {
            node.log('Starting from context-stored tweet ID ' + maxId);
        }

        if (node.connection !== null)
        {
            node.streamOptions.list_id = node.listId;
            if (node.includeRetweets === true) {
                node.streamOptions.include_rts = true;
            }

            node.status({fill:"green",shape:"dot",text:"connected"});

            var getListTweets = function() {
                node.log('fetching tweets');
                if (maxId !== 0) {
                    node.streamOptions.since_id = maxId;
                }

                // https://developer.twitter.com/en/docs/twitter-api/v1/accounts-and-users/create-manage-lists/api-reference/get-lists-statuses
                // https://github.com/ttezel/twit
                node.connection.client.get('lists/statuses', node.streamOptions, function (err, data, response){
                    if (err !== undefined) {
	                    node.status({fill:"yellow",shape:"dot",text:"error fetching tweets"});
	                    node.error(util.inspect(err, { showHidden: true, depth: null }));
                    }
                    else {
                        node.status({fill:"green",shape:"dot",text:"connected"});
                        let length = data.length;
                        if (length === 1 && data[0].id === maxId) {
                            node.log('Found 0 new tweets.');
                            return;
                        }
                        node.log('Found ' + length + ' new tweets.');
                        for (const tweet of data) {
                            if (tweet.id > maxId) {
                                maxId = tweet.id;  // TODO store persistent
                                nodeContext.set('twitter_list_stream_max_id', tweet.id);
                            }
                            (node.debug === true) ? node.log(util.inspect(tweet, { showHidden: true, depth: null })) : node.log(tweet.user.name + ': ' + tweet.text);
                            if (startup === false || node.triggerOnStartup === true ) {  // don't print if startup unless asked
                                asyncLoadAndSend(node.loadMedia, tweet, (tweet) => { node.send({payload: tweet}); });
                            }
                        }
                        if (startup === true) {
                            startup = false;
                        }
                    }
                    var sleep = (60000 - ((Math.floor(Math.random() * 10) + 1) * 1000))
                    node.log('sleeping for ' + sleep + 'ms');
                    setTimeout(getListTweets, sleep);
                });
            };
            getListTweets();
		}
		else {
			node.status({fill:"red",shape:"dot",text:"api connection not set"});
		}

        this.on("close", function() {
            if (node.stream) {
                node.log('stopping stream on close');
                node.stream.stop();
                node.streamOptions = null;
                delete node.stream;
            }
        });
    }

    //Twitter stream
    function TwitterStream(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        node.follow = n.follow || "";
        node.topics = n.topics || "";
        node.xmin = n.xmin || "";
        node.xmax = n.xmax || "";
        node.ymin = n.ymin || "";
        node.ymax = n.ymax || "";
        node.onlyPoints = n.onlyPoints || false;
        node.onlyBounded = n.onlyBounded || false;
        node.tweetLimit = parseInt(n.tweetLimit) || 0;
        node.onlyVerified = n.onlyVerified || false;
        node.topicRetweets = n.topicRetweets || false;
        node.allLanguages = n.allLanguages || false;
        node.topicLanguage = n.topicLanguage.toString().trim().split(",") || ['en','de'];
        node.loadMedia = n.loadMedia || false;
        node.debug = n.debug || false;
        node.waitForUserLookup = false;
        node.waitForValidCoords = false;
        node.userNames = [];
        node.userIDs = [];
        node.locations = [];
        node.streamOptions = {};
        node.tweetCount = 0;
        node.connection = RED.nodes.getNode(n.connection);
        node.status({fill:"yellow",shape:"dot",text:"connecting"});
        
        if (node.connection !== null)
        {	        
	        if (node.topics !== "") {
	            node.streamOptions.track = node.topics;
	        }
	        
	        if (node.follow !== "") {
	            node.waitForUserLookup = true;
	            node.connection.client.get('users/lookup', {screen_name: node.follow}, function(error, data, response){
	                if (error) {
	                    node.status({fill:"yellow",shape:"dot",text:"error user/lookup"});
	                    node.error(util.inspect(error, { showHidden: true, depth: null }));
	                }
	                try {
	                    for (var i=0; i < data.length; i++)
	                    {
	                        node.userIDs.push(data[i].id_str.toString());
	                        node.userNames.push(data[i].name.toString());
	                    }
	                    node.streamOptions.follow = node.userIDs.join(',').toString();
	                    node.log('streaming IDs: ' + node.streamOptions.follow);
	                    node.log('streaming Names: ' + node.userNames.join(',').toString());
	                }
	                catch (error) {
	                    node.error(util.inspect(error, { showHidden: true, depth: null }));
	                }
	                node.waitForUserLookup = false;
	            });
	        }

	        if (node.xmin !== "" || node.ymin !== "" || node.xmax !== "" || node.ymax !== "") {
	        	node.waitForValidCoords = true;
	        	if (node.xmin !== "" && node.ymin !== "" && node.xmax !== "" && node.ymax !== "") {
		        	if (between(node.xmin, -180, 180) && between(node.ymin, -90, 90) && between(node.xmax, -180, 180) && between(node.ymax, -90, 90)) {
		        		if (parseFloat(node.xmin) < parseFloat(node.xmax) && parseFloat(node.ymin) < parseFloat(node.ymax)) {
		        			node.locations = [node.xmin, node.ymin, node.xmax, node.ymax];
			        		node.streamOptions.locations = node.locations;
			        		node.waitForValidCoords = false;
			        	}
			        }
		        }
		    }
        
	        var startInterval = setInterval(() => {
	            if (node.waitForUserLookup === false) {
	            	if (node.waitForValidCoords === false) {
		                if (node.streamOptions.follow || node.streamOptions.track || node.streamOptions.locations) {
		                    node.stream = node.connection.client.stream('statuses/filter', node.streamOptions);
		                    node.stream.on('connect', function (request) {
		                        node.log('streaming API connecting');
		                        node.status({fill:"yellow",shape:"dot",text:"connecting"});
		                    });
		                    
		                    node.stream.on('connected', function (response) {
		                        node.log('streaming API connected ' + util.inspect(node.streamOptions, { showHidden: true, depth: null }));
		                        node.status({fill:"green",shape:"dot",text:"connected"});
		                    });
		                    
		                    node.stream.on('disconnect', function (disconnectMessage) {
		                        node.log('streaming API disconnected ' + util.inspect(disconnectMessage, { showHidden: true, depth: null }));
		                        node.status({fill:"red",shape:"dot",text:"disconnected"});
		                    });
		                    
		                    node.stream.on('reconnect', function (request, response, connectInterval) {
		                        node.log('streaming API reconnecting');
		                        node.status({fill:"yellow",shape:"dot",text:"reconnecting"});
		                    });
		                        
		                    node.stream.on('tweet', function(tweet) {
		                        
		                        (node.debug === true) ? node.log(util.inspect(tweet, { showHidden: true, depth: null })) : node.log(tweet.user.name + ': ' + tweet.text);
		                        
		                        // if followed user, immediately send tweet
		                        if (node.userIDs.indexOf(tweet.user.id_str) >= 0) {
		                            asyncLoadAndSend(node.loadMedia, tweet, (tweet) => { node.send({payload: tweet}); });
		                            return;
		                        }
		                        
		                        // if non requested language, drop tweet
		                        if (!node.allLanguages && node.topicLanguage.indexOf(tweet.lang) < 0) {
		                            node.log('skip: language https://twitter.com/statuses/' + tweet.id_str);
		                            return;
		                        }

		                        // if no point coordinate, drop tweet
		                        if (node.locations !== null && node.onlyPoints === true && tweet.geo === null) {
		                            node.log('skip: no coordinate https://twitter.com/statuses/' + tweet.id_str);
		                            return;
		                        }

		                        // if coordinate falls outside boundary, drop tweet (lat, lon)
		                        if (node.locations !== null && node.onlyBounded === true && 
		                        	(
		                        		(tweet.geo.coordinates[0] < node.ymin || tweet.geo.coordinates[0] > node.ymax) ||
		                        		(tweet.geo.coordinates[1] < node.xmin || tweet.geo.coordinates[1] > node.xmax)
		                        		)
		                        	)
		                        {
		                        	node.log('skip: outside boundary https://twitter.com/statuses/' + tweet.id_str);
		                            return;
		                        }
		                        
		                        // if onlyVerified and user is not a verified user, drop tweet
		                        if (node.onlyVerified === true && tweet.user.verified === false) {
		                            node.log('skip: unverified account https://twitter.com/statuses/' + tweet.id_str);
		                            return;
		                        }
		                        
		                        // if we reached the tweet limit per minute, drop tweet
		                        if (node.tweetLimit > 0 && (node.tweetCount >= node.tweetLimit)) {
		                            node.log('skip: tweet limit https://twitter.com/statuses/' + tweet.id_str);
		                            return;
		                        }
		                        
		                        // if no RT are allowed and tweet is a retweet, drop tweet
		                        if (node.topicRetweets === false && tweet.retweeted_status) {
		                            node.log('skip: retweet https://twitter.com/statuses/' + tweet.id_str);
		                            return;
		                        }
		                        
		                        node.tweetLimitCount += 1;
		                        setTimeout(() => {
		                            node.tweetLimitCount -= 1;
		                        }, (60000 - ((Math.floor(Math.random() * 10) + 1) * 1000)));
		                        asyncLoadAndSend(node.loadMedia, tweet, (tweet) => { node.send({payload: tweet}); });
		                    });
		                }
		                else {
		                    node.status({fill:"red",shape:"dot",text:"nothing to stream"});
		                }
		            }
		            else {
		            	node.status({fill:"red",shape:"dot",text:"invalid coordinates"});
		            }
	                clearInterval(startInterval);
	            }
	        }, 100);
		}
		else {
			node.status({fill:"red",shape:"dot",text:"api connection not set"});
		}

        this.on("close", function() {
            if (node.stream) {
                node.log('stopping stream on close');
                node.stream.stop();
                node.streamOptions = null;
                delete node.stream;
            }
        });
    }

    RED.nodes.registerType("Twitter Stream",TwitterStream);
    RED.nodes.registerType("Twitter List Stream",TwitterListStream);
};

const asyncLoadAndSend = (getMedia, tweet, cb) => {
    if (getMedia === true && tweet.extended_tweet && tweet.extended_tweet.entities && tweet.extended_tweet.entities.media && tweet.extended_tweet.entities.media.length > 0) {
        let run = 0;
        for (var i=0; i < tweet.extended_tweet.entities.media.length; i++) {
            (function(tweet, i) {
                tweet.extended_tweet.entities.media[i].download_url = tweet.extended_tweet.entities.media[i].media_url;
                if (tweet.extended_tweet.entities.media[i].type === 'video' || tweet.extended_tweet.entities.media[i].type === 'animated_gif') {
                    if (tweet.extended_tweet.entities.media[i].video_info.variants && tweet.extended_tweet.entities.media[i].video_info.variants.length > 0) {
                        for (var j=0; j < tweet.extended_tweet.entities.media[i].video_info.variants.length; j++) {
                            if (tweet.extended_tweet.entities.media[i].video_info.variants[j].content_type === 'video/mp4') {
                                tweet.extended_tweet.entities.media[i].download_url = tweet.extended_tweet.entities.media[i].video_info.variants[j].url;
                                break;
                            }
                        }
                    }
                }
                let options = {
                    agent: null
                }
                if (process.env.http_proxy)
                {
                    options.agent = new HttpsProxyAgent(url.parse(process.env.http_proxy));
                    node.log(`Using proxy ${process.env.http_proxy}`);
                }
                http.get(tweet.extended_tweet.entities.media[i].download_url, options, (res) => {
                    let data = [];
                    res.on('data', (chunk) => data.push(chunk));
                    res.on('end', () => {
                        run++;
                        tweet.extended_tweet.entities.media[i].buffer = Buffer.concat(data);
                        if (run == tweet.extended_tweet.entities.media.length) {
                            cb(tweet);
                        }
                    });
                });
            })(tweet, i);
        }
    }
    else {
        cb(tweet);
    }
}