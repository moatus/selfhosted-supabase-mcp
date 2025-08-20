#!/usr/bin/env node

/**
 * Test script for the remote MCP server
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';

async function testEndpoint(name, url, options = {}) {
    console.log(`\n🧪 Testing ${name}...`);
    try {
        const response = await fetch(url, options);
        const data = await response.text();
        
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
        if (response.headers.get('content-type')?.includes('application/json')) {
            try {
                const json = JSON.parse(data);
                console.log(`📄 Response:`, JSON.stringify(json, null, 2));
            } catch (e) {
                console.log(`📄 Response: ${data}`);
            }
        } else {
            console.log(`📄 Response: ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`);
        }
        return true;
    } catch (error) {
        console.log(`❌ ${name}: ${error.message}`);
        return false;
    }
}

async function testMCPRequest(name, method, params = {}) {
    console.log(`\n🔧 Testing MCP: ${name}...`);
    
    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: method,
        params: params
    };
    
    try {
        const response = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        console.log(`✅ MCP ${name}: ${response.status} ${response.statusText}`);
        console.log(`📄 Response:`, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.log(`❌ MCP ${name}: ${error.message}`);
        return false;
    }
}

async function runTests() {
    console.log('🚀 Starting Remote MCP Server Tests');
    console.log(`🎯 Target: ${BASE_URL}`);
    
    let passed = 0;
    let total = 0;
    
    // Test basic endpoints
    const basicTests = [
        ['Health Check', `${BASE_URL}/health`],
        ['Server Info', `${BASE_URL}/`],
        ['SSE Endpoint', `${BASE_URL}/sse`],
    ];
    
    for (const [name, url] of basicTests) {
        total++;
        if (await testEndpoint(name, url)) passed++;
    }
    
    // Test MCP endpoints
    const mcpTests = [
        ['List Tools', 'tools/list'],
        ['Server Info', 'initialize', { 
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
        }],
    ];
    
    for (const [name, method, params] of mcpTests) {
        total++;
        if (await testMCPRequest(name, method, params)) passed++;
    }
    
    // Summary
    console.log(`\n📊 Test Results: ${passed}/${total} tests passed`);
    
    if (passed === total) {
        console.log('🎉 All tests passed!');
        process.exit(0);
    } else {
        console.log('❌ Some tests failed');
        process.exit(1);
    }
}

// Check if server is running
async function checkServer() {
    try {
        await fetch(`${BASE_URL}/health`);
        return true;
    } catch (error) {
        return false;
    }
}

async function main() {
    console.log('🔍 Checking if server is running...');
    
    if (!(await checkServer())) {
        console.log('❌ Server is not running. Please start it first:');
        console.log('   npm run dev:remote');
        console.log('   or');
        console.log('   docker-compose -f docker-compose.remote.yml up -d');
        process.exit(1);
    }
    
    await runTests();
}

main().catch(console.error);
