package com.lib;

public class Slug {
    public static String of(String text) {
        return text.toLowerCase().replace(' ', '-');
    }
}
